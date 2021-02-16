'use strict';
const range = require('range');
const debug = require('debug')('blockManager');
const async = require('async');
const fs = require('fs');
const child_process = require('child_process');
const util = require('util');
const { sleep, monero } = require('./common');

// This file is for managing the block databases within the SQL database.
// Primary Tasks:
// Sync the chain into the block_log database. - Scan on startup for missing data, starting from block 0
// Maintain a check for valid blocks in the system. (Only last number of blocks required for validation of payouts) - Perform every 2 minutes.  Scan on the main blocks table as well for sanity sake.
// Maintain the block_log database in order to ensure payments happen smoothly. - Scan every 1 second for a change in lastblockheader, if it changes, insert into the DB.

let paymentInProgress = false;
let balanceIDCache = {};

let createBlockBalanceQueue = async.queue(function (task, callback) {
    global.mysql
        .query('REPLACE INTO block_balance (hex, payment_address, payment_id, amount) VALUES (?, ?, ?, ?)', [
            task.hex,
            task.payment_address,
            task.payment_id,
            task.amount,
        ])
        .then(function (result) {
            if (!result.hasOwnProperty('affectedRows') || (result.affectedRows != 1 && result.affectedRows != 2)) {
                console.error(JSON.stringify(result));
                console.error(
                    "Can't do SQL block balance replace: REPLACE INTO block_balance (" +
                        task.hex +
                        ', ' +
                        task.payment_address +
                        ', ' +
                        task.payment_id +
                        ', ' +
                        task.amount +
                        ');'
                );
                return callback(false);
            }
            return callback(true);
        })
        .catch(function (err) {
            console.error(err);
            console.error(
                "Can't do SQL block balance replace: REPLACE INTO block_balance (" +
                    task.hex +
                    ', ' +
                    task.payment_address +
                    ', ' +
                    task.payment_id +
                    ', ' +
                    task.amount +
                    ');'
            );
            return callback(false);
        });
}, 1);

let createBalanceQueue = async.queue(function (task, callback) {
    let pool_type = task.pool_type;
    let payment_address = task.payment_address;
    let payment_id = task.payment_id;
    let bitcoin = task.bitcoin;
    let query =
        'SELECT id FROM balance WHERE payment_address = ? AND payment_id is ? AND pool_type = ? AND bitcoin = ?';
    if (payment_id !== null) {
        query = 'SELECT id FROM balance WHERE payment_address = ? AND payment_id = ? AND pool_type = ? AND bitcoin = ?';
    }
    let cacheKey = payment_address + pool_type + bitcoin + payment_id;
    debug('Processing a account add/check for:' + JSON.stringify(task));
    global.mysql.query(query, [payment_address, payment_id, pool_type, bitcoin]).then(function (rows) {
        if (rows.length === 0) {
            global.mysql
                .query('INSERT INTO balance (payment_address, payment_id, pool_type, bitcoin) VALUES (?, ?, ?, ?)', [
                    payment_address,
                    payment_id,
                    pool_type,
                    bitcoin,
                ])
                .then(function (result) {
                    debug('Added to the SQL database: ' + result.insertId);
                    balanceIDCache[cacheKey] = result.insertId;
                    return callback();
                });
        } else {
            debug('Found it in MySQL: ' + rows[0].id);
            balanceIDCache[cacheKey] = rows[0].id;
            return callback();
        }
    });
}, 1);

let balanceQueue = async.queue(function (task, callback) {
    const pool_type = task.pool_type;
    const bitcoin = task.bitcoin;
    const amount = task.amount;
    const payment_address = task.payment_address;
    let payment_id = null;
    if (typeof task.payment_id !== 'undefined' && task.payment_id !== null && task.payment_id.length > 10)
        payment_id = task.payment_id;
    task.payment_id = payment_id;
    debug('Processing balance increment task: ' + JSON.stringify(task));
    async.waterfall(
        [
            function (intCallback) {
                let cacheKey = payment_address + pool_type + bitcoin + payment_id;
                if (cacheKey in balanceIDCache) {
                    return intCallback(null, balanceIDCache[cacheKey]);
                } else {
                    createBalanceQueue.push(task, function () {});
                    async.until(
                        function (untilCB) {
                            return untilCB(null, cacheKey in balanceIDCache);
                        },
                        function (intCallback) {
                            createBalanceQueue.push(task, function () {
                                return intCallback(null, balanceIDCache[cacheKey]);
                            });
                        },
                        function () {
                            return intCallback(null, balanceIDCache[cacheKey]);
                        }
                    );
                }
            },
            function (balance_id, intCallback) {
                debug(
                    'Made it to the point that I can update the balance for: ' +
                        balance_id +
                        ' for the amount: ' +
                        amount
                );
                global.mysql
                    .query('UPDATE balance SET amount = amount+? WHERE id = ?', [amount, balance_id])
                    .then(function (result) {
                        if (!result.hasOwnProperty('affectedRows') || result.affectedRows != 1) {
                            console.error(
                                "Can't do SQL balance update: UPDATE balance SET amount = amount+" +
                                    amount +
                                    ' WHERE id = ' +
                                    balance_id +
                                    ';'
                            );
                        }
                        return intCallback(null);
                    })
                    .catch(function (err) {
                        console.error(err);
                        console.error(
                            "Can't do SQL balance update: UPDATE balance SET amount = amount+" +
                                amount +
                                ' WHERE id = ' +
                                balance_id +
                                ';'
                        );
                    });
            },
        ],
        function () {
            return callback();
        }
    );
}, 24);

let is_full_stop = false;

function full_stop(err) {
    is_full_stop = true;
    console.error('Issue making balance increases: ' + JSON.stringify(err));
    console.error('Will not make more balance increases until it is resolved!');
    //toAddress, subject, body
    global.support.sendEmail(
        global.config.general.adminEmail,
        'blockManager unable to make balance increase',
        'Hello,\r\nThe blockManager has hit an issue making a balance increase: ' +
            JSON.stringify(err) +
            '.  Please investigate and restart blockManager as appropriate'
    );
}

let block_unlock_callback = null;
let prev_balance_sum = null;

// balanceQueue.drain(function () {
//     if (!paymentInProgress) {
//         debug("balanceQueue.drain: paymentInProgress is false");
//         return;
//     }
//     if (block_unlock_callback === null) {
//         debug("balanceQueue.drain: block_unlock_callback is not defined");
//         return;
//     }
//     if (prev_balance_sum === null) {
//         debug("balanceQueue.drain: prev_balance_sum is not defined");
//         return;
//     }
//     console.log("balanceQueue drained: performing block unlocking");
//     global.mysql.query("SELECT SUM(amount) as amt FROM balance").then(function (rows) {
//         if (typeof (rows[0]) === 'undefined' || typeof (rows[0].amt) === 'undefined') {
//             full_stop("SELECT SUM(amount) as amt FROM balance query returned undefined result");
//             block_unlock_callback = null;
//             prev_balance_sum = null;
//             paymentInProgress = false;
//             return;
//         }
//         let balance_sum = rows[0].amt;
//         if (balance_sum !== prev_balance_sum) {
//             console.log("Total balance changed from " + global.support.coinToDecimal(prev_balance_sum) + " to " + global.support.coinToDecimal(balance_sum));
//             block_unlock_callback();
//         } else {
//             full_stop("Total balance not changed from " + prev_balance_sum + " to " + balance_sum);
//         }
//         block_unlock_callback = null;
//         prev_balance_sum = null;
//         paymentInProgress = false;
//     });
// });

function calculatePPSPayments(blockHeader, callback) {
    if (global.config.pps.enable === false) return callback();
    console.log(
        'Performing PPS payout on block: ' +
            blockHeader.height +
            ' Block Value: ' +
            global.support.coinToDecimal(blockHeader.reward)
    );
    let paymentData = {};
    paymentData[global.config.payout.feeAddress] = {
        pool_type: 'fees',
        payment_address: global.config.payout.feeAddress,
        payment_id: null,
        bitcoin: 0,
        amount: 0,
    };
    paymentData[global.coinFuncs.coinDevAddress] = {
        pool_type: 'fees',
        payment_address: global.coinFuncs.coinDevAddress,
        payment_id: null,
        bitcoin: 0,
        amount: 0,
    };
    paymentData[global.coinFuncs.poolDevAddress] = {
        pool_type: 'fees',
        payment_address: global.coinFuncs.poolDevAddress,
        payment_id: null,
        bitcoin: 0,
        amount: 0,
    };
    let totalPayments = 0;
    if (global.config.pps.enable === true) {
        let txn = global.database.env.beginTxn({ readOnly: true });
        let cursor = new global.database.lmdb.Cursor(txn, global.database.shareDB);
        for (
            let found = cursor.goToRange(blockHeader.height) === blockHeader.height;
            found;
            found = cursor.goToNextDup()
        ) {
            cursor.getCurrentBinary(function (key, data) {
                // jshint ignore:line
                let shareData;
                try {
                    shareData = global.protos.Share.decode(data);
                } catch (e) {
                    console.error(e);
                    return;
                }
                let blockDiff = blockHeader.difficulty;
                let rewardTotal = blockHeader.reward;
                if (shareData.poolType === global.protos.POOLTYPE.PPS) {
                    let userIdentifier = shareData.paymentAddress;
                    if (shareData.paymentID) {
                        userIdentifier = userIdentifier + '.' + shareData.paymentID;
                    }
                    if (!(userIdentifier in paymentData)) {
                        paymentData[userIdentifier] = {
                            pool_type: 'pps',
                            payment_address: shareData.paymentAddress,
                            payment_id: shareData.paymentID,
                            bitcoin: shareData.bitcoin,
                            amount: 0,
                        };
                    }
                    let amountToPay = Math.floor((shareData.raw_shares / blockDiff) * rewardTotal);
                    let feesToPay = Math.floor(amountToPay * (global.config.payout.ppsFee / 100));
                    if (shareData.bitcoin === true) {
                        feesToPay += Math.floor(amountToPay * (global.config.payout.btcFee / 100));
                    }
                    amountToPay -= feesToPay;
                    paymentData[userIdentifier].amount = paymentData[userIdentifier].amount + amountToPay;
                    let donations = 0;
                    if (global.config.payout.devDonation > 0) {
                        let devDonation = feesToPay * (global.config.payout.devDonation / 100);
                        donations += devDonation;
                        paymentData[global.coinFuncs.coinDevAddress].amount =
                            paymentData[global.coinFuncs.coinDevAddress].amount + devDonation;
                    }
                    if (global.config.payout.poolDevDonation > 0) {
                        let poolDevDonation = feesToPay * (global.config.payout.poolDevDonation / 100);
                        donations += poolDevDonation;
                        paymentData[global.coinFuncs.poolDevAddress].amount =
                            paymentData[global.coinFuncs.poolDevAddress].amount + poolDevDonation;
                    }
                    paymentData[global.config.payout.feeAddress].amount =
                        paymentData[global.config.payout.feeAddress].amount + feesToPay - donations;
                }
            });
        }
        cursor.close();
        txn.abort();
    }
    Object.keys(paymentData).forEach(function (key) {
        balanceQueue.push(paymentData[key], function () {});
        totalPayments += paymentData[key].amount;
    });
    console.log(
        'PPS payout cycle complete on block: ' +
            blockHeader.height +
            ' Block Value: ' +
            global.support.coinToDecimal(blockHeader.reward) +
            ' Block Payouts: ' +
            global.support.coinToDecimal(totalPayments) +
            ' Payout Percentage: ' +
            (totalPayments / blockHeader.reward) * 100 +
            '%'
    );
    return callback();
}

async function preCalculatePPLNSPayments(block_hex, block_height, block_difficulty, is_store_dump, done_callback) {
    const rewardTotal = 1.0;
    console.log(
        'Performing PPLNS reward pre-calculations of block ' + block_hex + ' on (anchor) height ' + block_height
    );
    const blockDiff = block_difficulty;
    const windowPPLNS = blockDiff * global.config.pplns.shareMulti;

    let blockCheckHeight = block_height;
    let totalPaid = 0;
    let totalShares = 0;
    let paymentData = {};

    paymentData[global.config.payout.feeAddress] = {
        pool_type: 'fees',
        payment_address: global.config.payout.feeAddress,
        payment_id: null,
        bitcoin: 0,
        amount: 0,
    };
    paymentData[global.coinFuncs.coinDevAddress] = {
        pool_type: 'fees',
        payment_address: global.coinFuncs.coinDevAddress,
        payment_id: null,
        bitcoin: 0,
        amount: 0,
    };
    paymentData[global.coinFuncs.poolDevAddress] = {
        pool_type: 'fees',
        payment_address: global.coinFuncs.poolDevAddress,
        payment_id: null,
        bitcoin: 0,
        amount: 0,
    };

    function addPayment(keyAdd, valueAdd) {
        debug(`Adding ${valueAdd} for '${keyAdd}' `);
        if (valueAdd === 0) return;
        if (totalPaid >= rewardTotal) return;
        totalShares += valueAdd;
        paymentData[keyAdd].amount += valueAdd;
        const totalPaid2 = (totalShares / windowPPLNS) * rewardTotal;
        if (totalPaid2 > rewardTotal) {
            // totalPaid can not overflow rewardTotal now
            //console.log("Value totalPaid " + totalPaid  + " reached max " + rewardTotal);
            const extra = ((totalPaid2 - rewardTotal) / rewardTotal) * windowPPLNS;
            //console.log("Rewarded " + (valueAdd - extra)  + " instead of " + valueAdd  + " hashes for " + keyAdd);
            paymentData[keyAdd].amount -= extra;
            totalPaid = rewardTotal;
        } else {
            totalPaid = totalPaid2;
        }
    }

    let portShares = {};
    let firstShareTime;
    let lastShareTime;
    let shares4dump = [];

    const process = (callback) => {
        let txn = global.database.env.beginTxn({ readOnly: true });
        let cursor = new global.database.lmdb.Cursor(txn, global.database.shareDB);
        for (let found = cursor.goToRange(blockCheckHeight) === blockCheckHeight; found; found = cursor.goToNextDup()) {
            cursor.getCurrentBinary(function (key, data) {
                // jshint ignore:line
                let shareData;
                try {
                    shareData = global.protos.Share.decode(data);
                } catch (e) {
                    console.error(e);
                    return;
                }
                debug(`Processing share ${shareData.paymentAddress} (poolType = ${shareData.poolType}`);
                if (shareData.poolType === global.protos.POOLTYPE.PPLNS) {
                    return;
                }

                const userIdentifier = shareData.paymentID
                    ? shareData.paymentAddress + '.' + shareData.paymentID
                    : shareData.paymentAddress;
                if (!(userIdentifier in paymentData)) {
                    paymentData[userIdentifier] = {
                        pool_type: 'pplns',
                        payment_address: shareData.paymentAddress,
                        payment_id: shareData.paymentID,
                        bitcoin: shareData.bitcoin,
                        sourceCoin: shareData.sourceCoin,
                        amount: 0,
                    };
                }

                if (!firstShareTime) firstShareTime = shareData.timestamp;
                if (totalPaid < rewardTotal) lastShareTime = shareData.timestamp;

                const amountToPay = shareData.shares2;
                const feesToPay =
                    amountToPay * (global.config.payout.pplnsFee / 100) +
                    (shareData.bitcoin === true ? amountToPay * (global.config.payout.btcFee / 100) : 0);
                const devDonation = feesToPay * (global.config.payout.devDonation / 100);
                const poolDevDonation = feesToPay * (global.config.payout.poolDevDonation / 100);
                const amountToPay2 = amountToPay - feesToPay;

                shares4dump.push(
                    userIdentifier.slice(-16) +
                        '\t' +
                        shareData.timestamp.toString(16) +
                        '\t' +
                        shareData.raw_shares +
                        '\t' +
                        shareData.share_num +
                        '\t' +
                        global.coinFuncs.PORT2COIN_FULL(shareData.port) +
                        '\t' +
                        amountToPay +
                        '\t' +
                        (amountToPay === amountToPay2 ? '' : amountToPay2)
                );

                addPayment(userIdentifier, amountToPay2);
                addPayment(global.config.payout.feeAddress, feesToPay - devDonation - poolDevDonation);
                addPayment(global.coinFuncs.poolDevAddress, poolDevDonation);
                addPayment(global.coinFuncs.coinDevAddress, devDonation);

                if (shareData.port) {
                    if (shareData.port in portShares) {
                        portShares[shareData.port] += amountToPay;
                    } else {
                        portShares[shareData.port] = amountToPay;
                    }
                }
            });
        }
        cursor.close();
        txn.abort();
        setImmediate(callback, null, totalPaid);
    };

    const test = (totalPayment, whilstCB) => {
        blockCheckHeight = blockCheckHeight - 1;
        debug('Decrementing the block chain check height to:' + blockCheckHeight);
        if (totalPayment >= rewardTotal) {
            debug(
                'Loop 1: Total Payment: ' +
                    totalPayment +
                    ' Amount Paid: ' +
                    rewardTotal +
                    ' Amount Total: ' +
                    totalPaid
            );
            return whilstCB(null, false);
        } else {
            debug(
                'Loop 2: Total Payment: ' +
                    totalPayment +
                    ' Amount Paid: ' +
                    rewardTotal +
                    ' Amount Total: ' +
                    totalPaid
            );
            return whilstCB(null, blockCheckHeight > 0);
        }
    };

    const done = (err) => {
        if (err) {
            console.error(`Error in preCalculatePPLNSPayments: ${err}`);
            return done_callback(false);
        }
        let sumAllPorts = 0;
        for (let port in portShares) sumAllPorts += portShares[port];
        let pplns_port_shares = {};
        for (let port in portShares) {
            const port_share = portShares[port] / sumAllPorts;
            pplns_port_shares[port] = port_share;
            //console.log("Port " + port + ": " + (100.0 * port_share).toFixed(2) + "%");
        }
        global.database.setCache('pplns_port_shares', pplns_port_shares);
        global.database.setCache('pplns_window_time', (firstShareTime - lastShareTime) / 1000);

        let totalPayments = 0;
        Object.keys(paymentData).forEach(function (key) {
            totalPayments += paymentData[key].amount;
        });

        let is_dump_done = false;
        let is_ok = true;
        let is_pay_done = false;

        if (totalPayments == 0) {
            console.warn(
                'PPLNS payout cycle for ' +
                    block_hex +
                    ' block does not have any shares so will be redone using top height'
            );
            global.support.sendEmail(
                global.config.general.adminEmail,
                'FYI: No shares to pay block, so it was corrected by using the top height',
                'PPLNS payout cycle for ' +
                    block_hex +
                    ' block does not have any shares so will be redone using top height'
            );
            global.coinFuncs.getLastBlockHeader(function (err, body) {
                if (err !== null) {
                    console.error('Last block header request failed!');
                    return done_callback(false);
                }
                const topBlockHeight = body.height;
                return preCalculatePPLNSPayments(
                    block_hex,
                    topBlockHeight,
                    block_difficulty,
                    is_store_dump,
                    done_callback
                );
            });
            return;
        } else {
            if (is_store_dump && fs.existsSync('./block_share_dumps/process.sh')) {
                shares4dump.sort();
                shares4dump.unshift(
                    '#last_16_chars_of_xmr_address\ttimestamp\traw_share_diff\tshare_count\tshare_coin\txmr_share_diff\txmr_share_diff_payed'
                );
                const fn = 'block_share_dumps/' + block_hex + '.cvs';
                fs.writeFile(fn, shares4dump.join('\n'), function (err) {
                    if (err) {
                        console.error('Error saving ' + fn + ' file');
                        is_dump_done = true;
                        if (is_pay_done) return done_callback(is_ok);
                        return;
                    }
                    child_process.exec(
                        './block_share_dumps/process.sh ' + fn,
                        function callback(error, stdout, stderr) {
                            if (error)
                                console.error(
                                    './block_share_dumps/process.sh ' +
                                        fn +
                                        ': returned error exit code: ' +
                                        error.code +
                                        '\n' +
                                        stdout +
                                        '\n' +
                                        stderr
                                );
                            else console.log('./block_share_dumps/process.sh ' + fn + ': complete');
                            is_dump_done = true;
                            if (is_pay_done) return done_callback(is_ok);
                        }
                    );
                });
            } else {
                is_dump_done = true;
            }
        }

        const default_window = blockDiff * global.config.pplns.shareMulti;
        const is_need_correction = Math.abs(totalPayments / default_window - 1) > 0.0001;
        const pay_window = is_need_correction ? totalPayments : default_window;

        let add_count = 0;
        Object.keys(paymentData).forEach(function (key) {
            if (paymentData[key].amount) {
                paymentData[key].hex = block_hex;
                paymentData[key].amount = paymentData[key].amount / pay_window;
                ++add_count;
                createBlockBalanceQueue.push(paymentData[key], function (status) {
                    if (status === false) is_ok = false;
                    if (--add_count == 0) {
                        is_pay_done = true;
                        if (is_dump_done) return done_callback(is_ok);
                    }
                });
            }
        });

        console.log(
            'PPLNS payout cycle complete on block: ' +
                block_height +
                ' Payout Percentage: ' +
                (totalPayments / pay_window) * 100 +
                '% (precisely ' +
                totalPayments +
                ' / ' +
                pay_window +
                ')'
        );
        if (is_need_correction) {
            console.warn(
                '(This PPLNS payout cycle complete on block was corrected: ' +
                    block_height +
                    ' Payout Percentage: ' +
                    (totalPayments / default_window) * 100 +
                    '% (precisely ' +
                    totalPayments +
                    ' / ' +
                    default_window +
                    '))'
            );
            global.support.sendEmail(
                global.config.general.adminEmail,
                'Warning: Not enought shares to pay block correctly, so it was corrected by upscaling miner rewards!',
                'PPLNS payout cycle complete on block: ' +
                    block_height +
                    ' Payout Percentage: ' +
                    (totalPayments / pay_window) * 100 +
                    '% (precisely ' +
                    totalPayments +
                    ' / ' +
                    pay_window +
                    ')\n' +
                    '(This PPLNS payout cycle complete on block was corrected: ' +
                    block_height +
                    ' Payout Percentage: ' +
                    (totalPayments / default_window) * 100 +
                    '% (precisely ' +
                    totalPayments +
                    ' / ' +
                    default_window +
                    '))'
            );
        }
    };

    async.doWhilst(process, test, done);
}

function doPPLNSPayments(block_hex, block_reward, unlock_callback) {
    console.log(
        'Performing PPLNS payout of block ' + block_hex + ' with value ' + global.support.coinToDecimal(block_reward)
    );
    global.mysql.query('SELECT SUM(amount) as amt FROM balance').then(function (rows) {
        if (typeof rows[0] === 'undefined' || typeof rows[0].amt === 'undefined') {
            console.error('SELECT SUM(amount) as amt FROM balance query returned undefined result');
            return;
        }
        prev_balance_sum = rows[0].amt;

        global.mysql
            .query('SELECT payment_address, payment_id, amount FROM block_balance WHERE hex = ?', [block_hex])
            .then(function (rows) {
                if (rows.length) {
                    block_unlock_callback = unlock_callback;
                    rows.forEach(function (row) {
                        row.amount = Math.floor(row.amount * block_reward);
                        row.pool_type = 'pplns';
                        row.bitcoin = 0;
                        balanceQueue.push(row, function () {});
                    });
                } else {
                    console.error('Block ' + block_hex + ' has no payments in SQL');
                }
            });
    });
}

function calculateSoloPayments(blockHeader) {
    console.log(
        'Performing Solo payout on block: ' +
            blockHeader.height +
            ' Block Value: ' +
            global.support.coinToDecimal(blockHeader.reward)
    );
    let txn = global.database.env.beginTxn({ readOnly: true });
    let cursor = new global.database.lmdb.Cursor(txn, global.database.shareDB);
    let paymentData = {};
    paymentData[global.config.payout.feeAddress] = {
        pool_type: 'fees',
        payment_address: global.config.payout.feeAddress,
        payment_id: null,
        bitcoin: 0,
        amount: 0,
    };
    paymentData[global.coinFuncs.coinDevAddress] = {
        pool_type: 'fees',
        payment_address: global.coinFuncs.coinDevAddress,
        payment_id: null,
        bitcoin: 0,
        amount: 0,
    };
    paymentData[global.coinFuncs.poolDevAddress] = {
        pool_type: 'fees',
        payment_address: global.coinFuncs.poolDevAddress,
        payment_id: null,
        bitcoin: 0,
        amount: 0,
    };
    let totalPayments = 0;
    for (let found = cursor.goToRange(blockHeader.height) === blockHeader.height; found; found = cursor.goToNextDup()) {
        cursor.getCurrentBinary(function (key, data) {
            // jshint ignore:line
            let shareData;
            try {
                shareData = global.protos.Share.decode(data);
            } catch (e) {
                console.error(e);
                return;
            }
            let rewardTotal = blockHeader.reward;
            if (shareData.poolType === global.protos.POOLTYPE.SOLO && shareData.foundBlock === true) {
                let userIdentifier = shareData.paymentAddress;
                if (shareData.paymentID) {
                    userIdentifier = userIdentifier + '.' + shareData.paymentID;
                }
                if (!(userIdentifier in paymentData)) {
                    paymentData[userIdentifier] = {
                        pool_type: 'solo',
                        payment_address: shareData.paymentAddress,
                        payment_id: shareData.paymentID,
                        bitcoin: shareData.bitcoin,
                        amount: 0,
                    };
                }
                let feesToPay = Math.floor(rewardTotal * (global.config.payout.soloFee / 100));
                if (shareData.bitcoin === true) {
                    feesToPay += Math.floor(rewardTotal * (global.config.payout.btcFee / 100));
                }
                rewardTotal -= feesToPay;
                paymentData[userIdentifier].amount = rewardTotal;
                let donations = 0;
                if (global.config.payout.devDonation > 0) {
                    let devDonation = feesToPay * (global.config.payout.devDonation / 100);
                    donations += devDonation;
                    paymentData[global.coinFuncs.coinDevAddress].amount =
                        paymentData[global.coinFuncs.coinDevAddress].amount + devDonation;
                }
                if (global.config.payout.poolDevDonation > 0) {
                    let poolDevDonation = feesToPay * (global.config.payout.poolDevDonation / 100);
                    donations += poolDevDonation;
                    paymentData[global.coinFuncs.poolDevAddress].amount =
                        paymentData[global.coinFuncs.poolDevAddress].amount + poolDevDonation;
                }
                paymentData[global.config.payout.feeAddress].amount = feesToPay - donations;
            }
        });
    }
    cursor.close();
    txn.abort();
    Object.keys(paymentData).forEach(function (key) {
        balanceQueue.push(paymentData[key], function () {});
        totalPayments += paymentData[key].amount;
    });
    console.log(
        'Solo payout cycle complete on block: ' +
            blockHeader.height +
            ' Block Value: ' +
            global.support.coinToDecimal(blockHeader.reward) +
            ' Block Payouts: ' +
            global.support.coinToDecimal(totalPayments) +
            ' Payout Percentage: ' +
            (totalPayments / blockHeader.reward) * 100 +
            '%'
    );
}

let payReadyBlockHashCalc = {};

function blockPayments(block, cb) {
    if (paymentInProgress) {
        console.error("Skipping payment as there's a payment in progress");
        return cb();
    }
    switch (block.poolType) {
        case global.protos.POOLTYPE.PPS:
            // PPS is paid out per share find per block, so this is handled in the main block-find loop.
            global.database.unlockBlock(block.hash);
            return cb();

        case global.protos.POOLTYPE.PPLNS:
            global.coinFuncs.getBlockHeaderByHash(block.hash, function (err, header) {
                if (
                    err === null &&
                    block.height === header.height &&
                    block.value === header.reward &&
                    block.difficulty === header.difficulty
                ) {
                    if (paymentInProgress) {
                        console.error("Skipping payment as there's a payment in progress");
                        return cb();
                    }
                    paymentInProgress = true;
                    doPPLNSPayments(block.hash, block.value, function () {
                        console.log(
                            'Unlocking main block on ' +
                                block.height +
                                ' height with ' +
                                block.hash.toString('hex') +
                                ' hash'
                        );
                        global.database.unlockBlock(block.hash);
                        return cb();
                    });
                } else {
                    console.error("Can't get correct block header by hash " + block.hash.toString('hex'));
                    global.support.sendEmail(
                        global.config.general.adminEmail,
                        'blockManager unable to make blockPayments',
                        'Hello,\r\nThe blockManager has hit an issue making blockPayments with block ' +
                            block.hash.toString('hex')
                    );
                    return cb();
                }
            });
            break;
        case global.protos.POOLTYPE.SOLO:
            global.coinFuncs.getBlockHeaderByHash(block.hash, function (err, header) {
                if (err === null) {
                    calculateSoloPayments(header);
                    global.database.unlockBlock(block.hash);
                }
                return cb();
            });
            break;
        default:
            console.error('Unknown payment type. FREAKOUT');
            return cb();
    }
}

async function unlockBlocks() {
    debug('Looking for blocks that can be paid out...');
    if (is_full_stop) {
        console.warn('Block unlocker did not run because full stop is in effect');
        return;
    }
    //    if (scanInProgress) {
    //        debug("Skipping block unlocker run as there's a scan in progress");
    //        return;
    //    }
    if (paymentInProgress) {
        console.error("Skipping block unlocker run as there's a payment in progress");
        return;
    }
    let blockList = global.database.getValidLockedBlocks();
    debug(`Found ${blockList.length} valid block(s) awaiting payout`);
    if (blockList.length === 0) {
        return;
    }

    const b = await util.promisify((cb) => global.coinFuncs.getLastBlockHeader(cb))();
    const topBlockHeight = b.height;
    debug(`Tip block is ${topBlockHeight}`);

    for (const block of blockList) {
        // Dont process 5 blocks from the tip (5 confirmations minimum)
        if (topBlockHeight - block.height <= 5) return;

        const is_pplns_block = block.poolType === global.protos.POOLTYPE.PPLNS;
        debug(
            `Processing block ${block.height} ` +
                `(is_pplns_block = ${is_pplns_block.toString()}, hash = ${block.hash},` +
                ` pay_ready = ${block.pay_ready}, extra = ${JSON.stringify(block.extra)})`
        );

        let [err, resp] = await util
            .promisify((h, cb) => global.coinFuncs.getBlockHeaderByHash(block.hash, cb))(block.height)
            .then((r) => [null, r])
            .catch((err) => [err, null]);

        if (err) {
            throw new Error(`Failed to find block with hash ${block.hash}: ${err}`);
        }

        debug(`Daemon responded with block ${JSON.stringify(resp)}`);
        let { error, result } = resp;
        if (error) {
            // Regrettably, monerod returns an internal error when a hash is not found
            if (
                error.code === monero.MONERO_RPC_ERROR_CODE.INTERNAL_ERROR &&
                error.message.test(/can't get block by hash/)
            ) {
                // Invalid block
                console.log('Invalidating block ' + block.height + ' due to being an orphan block');
                global.database.invalidateBlock(block.height);
                continue;
            }
            throw new Error(`Failed to find block with hash ${block.hash}: (${error.code}) ${error.message}`);
        }

        console.log(result);
        // if (remoteBlock.hash !== block.hash) {
        //     //global.mysql.query("UPDATE block_log SET orphan = true WHERE hex = ?", [block.hash]);
        //     //blockIDCache.splice(blockIDCache.indexOf(block.height));
        //     continue;
        // }
        //
        // if (is_pplns_block && !(block.hash in payReadyBlockHashCalc) && block.pay_ready !== true) {
        //     debug(`Processing PPLNS payment for block ${block.height}`);
        //     payReadyBlockHashCalc[block.hash] = 1;
        //     preCalculatePPLNSPayments(block.hash, block.height, block.difficulty, true, function (is_success) {
        //         if (is_success) {
        //             console.log("Completed PPLNS reward pre-calculations of block " + block.hash + " on height " + block.height);
        //             global.database.payReadyBlock(block.hash);
        //         }
        //     });
        //     continue;
        // }
        //
        // if (topBlockHeight - block.height > global.config.payout.blocksRequired && (!is_pplns_block || block.pay_ready === true)) {
        //     blockPayments(block, function () { });
        //     continue;
        // }
    }
}

async function startBlockUnlocker() {
    while (true) {
        try {
            await unlockBlocks();
        } catch (err) {
            console.error(`Block unlocker errored: ${err}`);
        }

        await sleep(2 * 60 * 1000);
    }
}

startBlockUnlocker();
