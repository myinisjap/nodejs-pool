'use strict';
const range = require('range');
const { aux } = require('./common');
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

let createBlockBalanceQueue = async.queue(function (payout, callback) {
    debug(`createBlockBalanceQueue: inserting block ${payout.block_hash}`);
    global.mysql
        .query('REPLACE INTO block_balance (hex, payment_address, payment_id, amount, coin) VALUES (?, ?, ?, ?, ?)', [
            payout.block_hash,
            payout.payment_address,
            payout.payment_id || null,
            payout.amount,
            payout.coin,
        ])
        .then(function (result) {
            if (!result.hasOwnProperty('affectedRows') || (result.affectedRows !== 1 && result.affectedRows !== 2)) {
                console.error(JSON.stringify(result));
                console.error(
                    "Can't do SQL block balance replace: REPLACE INTO block_balance (" +
                        payout.block_hash +
                        ', ' +
                        payout.payment_address +
                        ', ' +
                        payout.payment_id +
                        ', ' +
                        payout.amount +
                        ');',
                );
                return callback(false);
            }
            return callback(true);
        })
        .catch(function (err) {
            console.error(err);
            console.error(
                "Can't do SQL block balance replace: REPLACE INTO block_balance (" +
                    payout.block_hash +
                    ', ' +
                    payout.payment_address +
                    ', ' +
                    payout.payment_id +
                    ', ' +
                    payout.amount +
                    ');',
            );
            return callback(false);
        });
}, 1);

let createBalanceQueue = async.queue(function (task, callback) {
    let pool_type = task.pool_type;
    let payment_address = task.payment_address;
    let payment_id = task.payment_id;
    let bitcoin = task.bitcoin;
    const coin = task.coin;
    let query =
        'SELECT id FROM balance WHERE payment_address = ? AND payment_id is ? AND pool_type = ? AND bitcoin = ? AND coin = ?';
    if (payment_id !== null) {
        query =
            'SELECT id FROM balance WHERE payment_address = ? AND payment_id = ? AND pool_type = ? AND bitcoin = ? AND coin = ?';
    }
    let cacheKey = payment_address + pool_type + bitcoin + payment_id;
    debug('Processing a account add/check for:' + JSON.stringify(task));
    global.mysql.query(query, [payment_address, payment_id, pool_type, bitcoin, coin]).then(function (rows) {
        if (rows.length === 0) {
            global.mysql
                .query(
                    'INSERT INTO balance (payment_address, payment_id, pool_type, bitcoin, coin) VALUES (?, ?, ?, ?, ?)',
                    [payment_address, payment_id, pool_type, bitcoin, coin],
                )
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
    const coin = task.coin;
    const payment_address = task.payment_address;
    let payment_id = null;
    if (typeof task.payment_id !== 'undefined' && task.payment_id !== null && task.payment_id.length > 10) {
        payment_id = task.payment_id;
    }
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
                        },
                    );
                }
            },
            function (balance_id, intCallback) {
                debug(
                    `Made it to the point that I can update the balance for: ${balance_id} for the amount: ${coin} ${amount}`,
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
                                    ';',
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
                                ';',
                        );
                    });
            },
        ],
        function () {
            debug('createBalanceQueue done');
            return callback();
        },
    );
}, 24);

let is_full_stop = false;

function full_stop(err) {
    is_full_stop = true;
    console.error('FULL STOP 🚨');
    console.error('Issue making balance increases: ' + JSON.stringify(err));
    console.error('Will not make more balance increases until it is resolved!');
    //toAddress, subject, body
    global.support.sendEmail(
        global.config.general.adminEmail,
        'blockManager unable to make balance increase',
        'Hello,\r\nThe blockManager has hit an issue making a balance increase: ' +
            JSON.stringify(err) +
            '.  Please investigate and restart blockManager as appropriate',
    );
}

let prev_balance_sum = {};

balanceQueue.drain(function () {
    if (!paymentInProgress) {
        debug('balanceQueue.drain: paymentInProgress is false');
        return;
    }
    paymentInProgress = false;

    console.log('balanceQueue drained: performing block unlocking');
    global.mysql.query('SELECT SUM(amount), coin as amt FROM balance').then(function (rows) {
        if (typeof rows[0] === 'undefined' || typeof rows[0].amt === 'undefined') {
            full_stop('SELECT SUM(amount), coin as amt FROM balance query returned undefined result');
            return;
        }

        const balance_sum = rows[0].amt;
        const coin = rows[0].coin;
        const prevBalance = prev_balance_sum[coin];
        if (prevBalance === null) {
            debug(`balanceQueue.drain: prev_balance_sum['${coin}'] is not defined`);
            return;
        }
        if (balance_sum !== prevBalance) {
            console.log(
                'Total balance changed from ' +
                    global.support.coinToDecimal(prevBalance) +
                    ' to ' +
                    global.support.coinToDecimal(balance_sum),
            );
        } else {
            full_stop('Total balance not changed from ' + prevBalance + ' to ' + balance_sum);
        }
        delete prev_balance_sum[coin];
    });
});

function calculatePPSPayments(blockHeader, callback) {
    if (global.config.pps.enable === false) return callback();
    console.log(
        'Performing PPS payout on block: ' +
            blockHeader.height +
            ' Block Value: ' +
            global.support.coinToDecimal(blockHeader.reward),
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
    console.log(
        'PPS payout cycle complete on block: ' +
            blockHeader.height +
            ' Block Value: ' +
            global.support.coinToDecimal(blockHeader.reward) +
            ' Block Payouts: ' +
            global.support.coinToDecimal(totalPayments) +
            ' Payout Percentage: ' +
            (totalPayments / blockHeader.reward) * 100 +
            '%',
    );
    return callback();
}

function doPPLNSPayments(block_hex, block_reward, coin, unlock_callback) {
    console.log(
        `[${coin}] Performing PPLNS payout of block ${block_hex} with value ${global.support.coinToDecimal(
            block_reward,
        )}`,
    );
    global.mysql.query('SELECT SUM(amount) as amt FROM balance where coin = ?', [coin]).then(function (rows) {
        if (typeof rows[0] === 'undefined' || typeof rows[0].amt === 'undefined') {
            paymentInProgress = false;
            console.error('SELECT SUM(amount) as amt FROM balance query returned undefined result');
            return;
        }
        prev_balance_sum[coin] = rows[0].amt;

        global.mysql
            .query('SELECT payment_address, payment_id, amount, coin FROM block_balance WHERE hex = ?', [block_hex])
            .then(function (rows) {
                if (rows.length === 0) {
                    paymentInProgress = false;
                    console.error('Block ' + block_hex + ' has no block balance payments in SQL');
                    return;
                }

                rows.forEach(function (row) {
                    row.amount = Math.floor(row.amount * block_reward);
                    if (row.amount === 0) {
                        console.error('Update to zero????', row);
                    }
                    row.pool_type = 'pplns';
                    row.bitcoin = 0;
                    balanceQueue.push(row, function () {
                        unlock_callback();
                    });
                });
            });
    });
}

function calculateSoloPayments(blockHeader) {
    console.log(
        'Performing Solo payout on block: ' +
            blockHeader.height +
            ' Block Value: ' +
            global.support.coinToDecimal(blockHeader.reward),
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
        totalPayments += paymentData[key].amount;
        balanceQueue.push(paymentData[key], function () {});
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
            '%',
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
                if (err) {
                    console.error(err);
                    global.support.sendEmail(
                        global.config.general.adminEmail,
                        'blockManager unable to make blockPayments',
                        `Hello,\r\nThe blockManager has hit an issue making blockPayments with block  ${err.toString()}`,
                    );
                    return cb(err);
                }

                if (
                    block.height !== header.height ||
                    block.value !== header.reward ||
                    block.difficulty !== header.difficulty
                ) {
                    console.error("Can't get correct block header by hash " + block.hash.toString('hex'));
                    global.support.sendEmail(
                        global.config.general.adminEmail,
                        'blockManager unable to make blockPayments',
                        'Hello,\r\nThe blockManager has hit an issue making blockPayments with block. It did not match the expected header values.\n\n' +
                            `height: got ${block.height}, expected ${header.height}\n` +
                            `value: got ${block.value}, expected ${header.reward}\n` +
                            `difficulty: got ${block.difficulty}, expected ${header.difficulty}`,
                    );
                    return cb(new Error("Can't get correct block header by hash " + block.hash.toString('hex')));
                }
                debug(
                    `Block payment: height = ${block.height}, value = ${block.value}, difficulty = ${block.difficulty}`,
                );
                if (paymentInProgress) {
                    console.error('Ignoring payment for now because there is another payment in progress');
                    return cb(new Error('payment in progress'));
                }
                paymentInProgress = true;
                doPPLNSPayments(block.hash, block.value, block.coin, function () {
                    console.log(
                        'Unlocking main block on ' +
                            block.height +
                            ' height with ' +
                            block.hash.toString('hex') +
                            ' hash',
                    );
                    if (!global.database.unlockBlock(block.hash)) {
                        debug(`unlocking block: Block ${block.hash} not on the parent chain. Attempting alt chain`);
                        if (!global.database.unlockAltBlock(block.hash)) {
                            console.error(`Failed to unlock block with hash ${block.hash}`);
                            // TODO: probably should FULL STOP
                        }
                    }
                    return cb();
                });
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
    debug('Looking for MONERO blocks that can be paid out...');
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

    let lastHeader = await util.promisify((cb) => global.coinFuncs.getLastBlockHeader(cb))();
    lastHeader = lastHeader.block_header;
    const tipHeight = lastHeader.height;
    debug(`Tip block is ${tipHeight}`);

    for (const block of blockList) {
        let depth = tipHeight - block.height;
        if (depth < global.config.payout.blocksRequired) {
            console.log(
                `Block ${block.height} (${block.hash}) does not have the required depth for processing (required = ${global.config.payout.blocksRequired}, has = ${depth}). Skipped.`,
            );
            return;
        }

        const is_pplns_block = block.poolType === global.protos.POOLTYPE.PPLNS;
        debug(
            `Processing block ${block.height} ` +
                `(is_pplns_block = ${is_pplns_block.toString()}, hash = ${block.hash},` +
                ` pay_ready = ${block.pay_ready}, extra = ${JSON.stringify(block.extra)})`,
        );

        const [error, resp] = await util
            .promisify((h, cb) => global.coinFuncs.getBlockHeaderByHash(block.hash, cb))(block.height)
            .then((r) => [null, r])
            .catch((err) => [err, null]);

        debug(`Daemon responded with block ${JSON.stringify(resp)}`);
        if (error) {
            // Regrettably, monerod returns an internal error when a hash is not found
            if (
                error.code === monero.MONERO_RPC_ERROR_CODE.INTERNAL_ERROR &&
                /can't get block by hash/.test(error.message)
            ) {
                // Invalid block
                console.log('Invalidating block ' + block.height + ' due to being an orphan block');
                global.database.invalidateBlock(block.height);
                continue;
            }
            throw new Error(`Failed to find block with hash ${block.hash}: (${error.code}) ${error.message}`);
        }

        switch (block.poolType) {
            case global.protos.POOLTYPE.PPLNS: {
                if (!block.pay_ready) {
                    if (block.hash in payReadyBlockHashCalc) {
                        debug(`PPLNS payment for block ${block.height} is already marked for payout`);
                        continue;
                    }

                    debug(`Processing PPLNS payment for block ${block.height}`);
                    payReadyBlockHashCalc[block.hash] = 1;
                    await processPplnsPayments(block);
                    let numChanged = global.database.payReadyBlock(block.hash);
                    debug(`Marked ${numChanged} alt blocks as ready for payout`);
                    continue;
                }

                await new Promise((resolve) => {
                    blockPayments(block, resolve);
                });

                break;
            }
            default: {
                if (tipHeight - block.height > global.config.payout.blocksRequired && block.pay_ready) {
                    await new Promise((resolve) => {
                        blockPayments(block, resolve);
                    });
                    continue;
                }
            }
        }
    }
}

async function unlockAuxBlocks(auxCoin) {
    debug('Looking for AUX blocks that can be paid out...');
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
    let blockList = global.database.getValidLockedAltBlocks();
    debug(`Found ${blockList.length} valid block(s) awaiting payout`);
    if (blockList.length === 0) {
        return;
    }

    const response = await util.promisify((cb) => global.coinFuncs.getLastBlockHeader(cb))();
    let auxData = aux.findChainData(response, auxCoin);
    if (!auxData) {
        console.warn(
            `Unable to unlock ${blockList.length} valid aux block(s) because no aux chain data found for ${auxCoin}.`,
        );
        return;
    }
    const { block_header: blockHeader } = auxData;

    const tipHeight = blockHeader.height;
    debug(`${auxCoin.toUpperCase()} tip block is ${tipHeight}`);

    for (const block of blockList) {
        let depth = tipHeight - block.height;
        if (depth < global.config.payout.blocksRequired) {
            console.log(
                `Block ${block.height} (${block.hash}) does not have the required number of confirmations for processing (5). Skipped.`,
            );
            return;
        }

        const is_pplns_block = block.poolType === global.protos.POOLTYPE.PPLNS;
        debug(
            `Processing block ${block.height} ` +
                `(is_pplns_block = ${is_pplns_block.toString()}, hash = ${block.hash},` +
                ` pay_ready = ${block.pay_ready}, extra = ${JSON.stringify(block.extra)})`,
        );

        const [error, resp] = await util
            .promisify((h, cb) => global.coinFuncs.getBlockHeaderByHash(block.hash, cb))(block.height)
            .then((r) => [null, r])
            .catch((err) => [err, null]);

        debug(`Daemon responded with block ${JSON.stringify(resp)}`);
        if (error) {
            // Regrettably, monerod returns an internal error when a hash is not found
            if (
                error.code === monero.MONERO_RPC_ERROR_CODE.INTERNAL_ERROR &&
                /can't get block by hash/.test(error.message)
            ) {
                // Invalid block
                console.log('Invalidating block ' + block.height + ' due to being an orphan block');
                global.database.invalidateAltBlock(block.height);
                continue;
            }
            throw new Error(`Failed to find block with hash ${block.hash}: (${error.code}) ${error.message}`);
        }

        switch (block.poolType) {
            case global.protos.POOLTYPE.PPLNS: {
                debug('poolType is PPLNS');
                if (block.hash in payReadyBlockHashCalc) {
                    debug(`PPLNS payment for block ${block.height} is already marked for payout`);
                    continue;
                }

                if (!block.pay_ready) {
                    debug(`Processing PPLNS payment for block ${block.height}`);
                    payReadyBlockHashCalc[block.hash] = 1;
                    await processPplnsPayments(block);
                    let numChanged = global.database.payReadyAltBlock(block.hash);
                    debug(`Marked ${numChanged} alt blocks as ready for payout`);

                    continue;
                }

                const depth = tipHeight - block.height;
                if (block.pay_ready && depth > global.config.payout.blocksRequired) {
                    debug(`Block payments ready (depth = ${depth})`);
                    blockPayments(block, function () {});
                }

                break;
            }
            default: {
                debug(`poolType is ${block.poolType}`);
                if (tipHeight - block.height > global.config.payout.blocksRequired && block.pay_ready) {
                    blockPayments(block, function () {});
                    continue;
                }
            }
        }
    }
}

function Payout(blockHash, coin, poolType, paymentAddress) {
    Object.assign(this, {
        block_hash: blockHash,
        coin: coin,
        pool_type: poolType,
        payment_address: paymentAddress,
        payment_id: null,
        bitcoin: 0,
        amount: 0,
    });

    debug(`Created new Payout object (${JSON.stringify(this)}`);

    this.addAmount = (amount) => {
        let num = Number(amount);
        if (Number.isNaN(num)) {
            throw new Error(`Invalid amount '${amount}' given to Payout::addAmount`);
        }
        this.amount += num;
        debug(
            `${amount} added to address ${aux.tryExtractAddress(this.payment_address, this.coin)}. New amount ${
                this.amount
            }`,
        );
    };
}

Payout.new = (...args) => new Payout(...args);

async function processPplnsPayments(block) {
    const coin = block.coin || 'xmr';
    console.log(
        `Performing PPLNS reward pre-calculations of ${coin} block ${block.hash} on height ${block.height} (anchor = ${block.anchor_height})`,
    );

    // windowPPLNS is the N in PPLNS
    const windowPPLNS = block.difficulty * global.config.pplns.shareMulti;
    // rewardTotal is the maximum average payout per address within the PPLNS window
    const rewardTotal = 1.0;
    // totalPaid is the current average payout per address within the PPLNS window
    let totalPaid = 0;

    let blockHeight = block.anchor_height || block.height;
    let totalShares = 0;
    let firstShareTime;
    let lastShareTime;
    // if (totalPaid >= rewardTotal) return;

    const finalPayouts = {};

    const feePayout = Payout.new(block.hash, block.coin, 'fees', global.config.payout.feeAddress);
    const coinDevPayout = Payout.new(block.hash, coin, 'fees', global.coinFuncs.coinDevAddress);
    const poolDevPayout = Payout.new(block.hash, coin, 'fees', global.coinFuncs.poolDevAddress);

    finalPayouts[feePayout.payment_address] = feePayout;
    finalPayouts[coinDevPayout.payment_address] = coinDevPayout;
    finalPayouts[poolDevPayout.payment_address] = poolDevPayout;

    {
        let txn = global.database.env.beginTxn({ readOnly: true });
        let cursor = new global.database.lmdb.Cursor(txn, global.database.shareDB);
        while (totalPaid < rewardTotal && blockHeight > 0) {
            debug(
                `[${coin}] Checking shares for Height: ${blockHeight} Total Payment: ${totalPaid} Amount Paid: ${rewardTotal} Amount Total: ${totalPaid}`,
            );
            let key = cursor.goToKey(blockHeight);
            for (let found = !!key; found; found = cursor.goToNextDup()) {
                // Load share at height
                const share = await new Promise((resolve, reject) => {
                    cursor.getCurrentBinary((_key, data) => {
                        if (!data) {
                            reject('no data found at cursor');
                            return;
                        }
                        try {
                            resolve(global.protos.Share.decode(data));
                        } catch (e) {
                            reject(e);
                        }
                    });
                });

                // Ignore all non PPLNS shares in this function
                if (share.poolType !== global.protos.POOLTYPE.PPLNS) {
                    continue;
                }

                const getUserIdentifier = (share) => {
                    const paymentAddress = aux.tryExtractAddress(share.paymentAddress, coin);
                    if (share.paymentID) {
                        return `${paymentAddress}.${share.paymentId}`;
                    }
                    return paymentAddress;
                };

                const userId = getUserIdentifier(share);
                let currentPayout = finalPayouts[userId];
                if (!currentPayout) {
                    const payout = Payout.new(block.hash, coin, 'pplns', share.paymentAddress);
                    payout.payment_id = share.paymentID;
                    payout.bitcoin = share.bitcoin;
                    currentPayout = finalPayouts[userId] = payout;
                }

                // Calculate user amount and fees for the payout transaction
                const shareValue = share.shares2;
                const totalFees =
                    shareValue * (global.config.payout.pplnsFee / 100) +
                    (share.bitcoin ? shareValue * (global.config.payout.btcFee / 100) : 0);

                const amount = shareValue - totalFees;
                const devDonation = totalFees * (global.config.payout.devDonation / 100);
                const poolDonation = totalFees * (global.config.payout.poolDevDonation / 100);
                const feeAmount = totalFees - devDonation - poolDonation;

                debug(
                    `[${coin}] Adding payout amounts [${currentPayout.payment_address}]: ${amount}, shareValue = ${shareValue}, poolDev = ${poolDonation}, coinDev = ${devDonation}, totalDevFees = ${totalFees}, fees = ${feeAmount}`,
                );

                if (!firstShareTime) firstShareTime = share.timestamp;
                if (totalPaid < rewardTotal) lastShareTime = share.timestamp;

                const addPayment = (payout, amount) => {
                    if (amount === 0) return;
                    if (totalPaid >= rewardTotal) return;
                    totalShares += amount;
                    let avgPayout = (totalShares / windowPPLNS) * rewardTotal;
                    if (avgPayout > rewardTotal) {
                        const extra = ((avgPayout - rewardTotal) / rewardTotal) * windowPPLNS;
                        amount -= extra;
                        payout.addAmount(amount);
                        totalPaid = rewardTotal;
                    } else {
                        payout.addAmount(amount);
                        totalPaid = avgPayout;
                    }
                    debug(
                        `[${coin}] addPayment: address = ${payout.address} avgPayout = ${avgPayout} total = ${totalPaid}`,
                    );
                };

                addPayment(currentPayout, amount);
                addPayment(poolDevPayout, poolDonation);
                addPayment(coinDevPayout, devDonation);
                addPayment(feePayout, feeAmount);
            }

            break;
            // Just keeping this here for now in case I've missed the point of the loop.
            blockHeight = blockHeight - 1;
        }
        cursor.close();
        txn.abort();
    }

    global.database.setCache('pplns_window_time', (firstShareTime - lastShareTime) / 1000);

    const totalPayments = Object.keys(finalPayouts).reduce((acc, key) => acc + finalPayouts[key].amount, 0);
    console.log(
        `[${coin}] Paying out to ${
            Object.keys(finalPayouts).length
        } address(es), a total of ${totalPayments} for block ${block.hash}`,
    );

    const is_need_correction = Math.abs(totalPayments / windowPPLNS - 1) > 0.0001;
    const payWindow = is_need_correction ? totalPayments : windowPPLNS;

    debug(`payWindow = ${payWindow}, is_need_correction = ${is_need_correction}, totalPayments = ${totalPayments}`);

    let is_ok = true;
    console.log(finalPayouts);
    Object.keys(finalPayouts).forEach(function (key) {
        if (finalPayouts[key].amount === 0) {
            debug(`Skipping 0 payout for block ${finalPayouts[key].block_hash}`);
            return;
        }
        let finalAmount = finalPayouts[key].amount / payWindow;
        debug(`${key}: ${finalPayouts[key].amount} / ${payWindow} = ${finalAmount}`);
        finalPayouts[key].amount = finalAmount;
        createBlockBalanceQueue.push(finalPayouts[key], function (is_success) {
            if (is_success) {
                debug(`createBlockBalanceQueue completed successfully for ${key}`);
            } else {
                debug(`createBlockBalanceQueue FAILED for ${key}`);
                is_ok = false;
            }
        });
    });
    if (!is_ok) {
        console.error('FAILURE UPDATING BLOCK BALANCE');
    }

    console.log(
        `[${coin}] PPLNS payout cycle complete on block: ${block.height} Payout Percentage: ${
            (totalPayments / payWindow) * 100
        }% (precisely ${totalPayments} / ${payWindow})`,
    );
    if (is_need_correction) {
        console.warn(
            '(This PPLNS payout cycle complete on block was corrected: ' +
                blockHeight +
                ' Payout Percentage: ' +
                (totalPayments / windowPPLNS) * 100 +
                '% (precisely ' +
                totalPayments +
                ' / ' +
                windowPPLNS +
                '))',
        );
        global.support.sendEmail(
            global.config.general.adminEmail,
            'Warning: Not enough shares to pay block correctly, so it was corrected by upscaling miner rewards!',
            'PPLNS payout cycle complete on block: ' +
                blockHeight +
                ' Payout Percentage: ' +
                (totalPayments / payWindow) * 100 +
                '% (precisely ' +
                totalPayments +
                ' / ' +
                payWindow +
                ')\n' +
                '(This PPLNS payout cycle complete on block was corrected: ' +
                block.height +
                ' Payout Percentage: ' +
                (totalPayments / windowPPLNS) * 100 +
                '% (precisely ' +
                totalPayments +
                ' / ' +
                windowPPLNS +
                '))',
        );
    }
}

const SLEEP_INTERVAL = 30 * 1000;
async function startBlockUnlocker() {
    while (true) {
        try {
            // await unlockBlocks();
            await unlockAuxBlocks('xtr');
        } catch (err) {
            console.error(err.stack);
            break;
        }

        await sleep(SLEEP_INTERVAL);
    }
}

if (!global.__dontRunBlockManager) {
    startBlockUnlocker();
}

module.exports = {
    startBlockUnlocker,
    unlockBlocks,
    unlockAuxBlocks,
};
