"use strict";
const bignum = require('bignum');
const cnUtil = require('cryptonote-util');
const multiHashing = require("cryptonight-hashing");
const crypto = require('crypto');

const ADDRESS_DELIM = "/";

function TariCoin(data) {
    this.data = data;
    this.isxmr = true;
    this.bestExchange = global.config.payout.bestExchange;
    let instanceId = crypto.randomBytes(4);
    this.coinDevAddress = "NWY1onxeKgcCK8BvdffsraVpkBe6DJbwodm8yxT2eFC1/51skQCSE9dAJjWPe6RWojZ536oQHMLUYxZPei3B32YLTcdEX37X6xBR1PFwA3hmYciNz4kpC3cuuy6XH8SQV7f5E5AnKQkF";  // Developer Address
    this.poolDevAddress = "NWY1onxeKgcCK8BvdffsraVpkBe6DJbwodm8yxT2eFC1/51skQCSE9dAJjWPe6RWojZ536oQHMLUYxZPei3B32YLTcdEX37X6xBR1PFwA3hmYciNz4kpC3cuuy6XH8SQV7f5E5AnKQkF";  // Snipa Address

    this.blockedAddresses = [
        this.coinDevAddress,
        this.poolDevAddress,
    ];

    this.exchangeAddresses = [ ]; // These are addresses that MUST have a paymentID to perform logins with.

    this.prefix = 18;
    this.intPrefix = 19;
    this.subPrefix = 42;


    if (global.config.general.stagenet === true) {
        // Stagenet
        this.prefix = 24;
        this.intPrefix = 25;
        this.subPrefix = 36;
    } else if (global.config.general.testnet === true) {
        this.prefix = 53;
        this.intPrefix = 54;
        this.subPrefix = 63;
    }
    this.supportsAutoExchange = true;

    this.niceHashDiff = 400000;

    this.getBlockHeaderByID = function (blockId, callback) {
        global.support.rpcDaemon('getblockheaderbyheight', {"height": blockId}, function (body) {
            if (body.hasOwnProperty('result')) {
                return callback(null, body.result.block_header);
            } else {
                console.error(JSON.stringify(body));
                return callback(true, body);
            }
        });
    };

    this.getBlockHeaderByHash = function (blockHash, callback) {
        global.support.rpcDaemon('getblockheaderbyhash', {"hash": blockHash}, function (body) {
            if (typeof (body) !== 'undefined' && body.hasOwnProperty('result')) {
                return callback(null, body.result.block_header);
            } else {
                console.error(JSON.stringify(body));
                return callback(true, body);
            }
        });
    };

    this.getLastBlockHeader = function (callback) {
        global.support.rpcDaemon('getlastblockheader', [], function (body) {
            if (typeof (body) !== 'undefined' && body.hasOwnProperty('result')) {
                return callback(null, body.result.block_header);
            } else {
                console.error(JSON.stringify(body));
                return callback(true, body);
            }
        });
    };

    this.getBlockTemplate = function (walletAddress, callback) {
        global.support.rpcDaemon('getblocktemplate', {
            reserve_size: 17,
            wallet_address: walletAddress
        }, function (body) {
            return callback(body);
        });
    };

    this.baseDiff = function () {
        return bignum('FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF', 16);
    };

    this.validateAddress = function (address) {
        const [tari_pk, monero_addr] = address.split(ADDRESS_DELIM, 2);
        if (!monero_addr || !tari_pk) {
            return false;
        }

        // TODO: uncomment when tari-crypto#28 is merged
        // if (!tari_crypto.pubkey_from_hex(tari_pk)) {
        //     return false
        // }

        let monero_buf = new Buffer(monero_addr);
        let decoded_address = cnUtil.address_decode(monero_buf);
        if (decoded_address === this.prefix || decoded_address === this.subPrefix) {
            return true;
        }
        return cnUtil.address_decode_integrated(monero_buf) === this.intPrefix;
    };

    this.convertBlob = function (blobBuffer) {
        return cnUtil.convert_blob(blobBuffer);
    };

    this.constructNewBlob = function (blockTemplate, NonceBuffer) {
        return cnUtil.construct_block_blob(blockTemplate, NonceBuffer);
    };

    this.getBlockID = function (blockBuffer) {
        return cnUtil.get_block_id(blockBuffer);
    };

    this.BlockTemplate = function (template) {
        /*
        Generating a block template is a simple thing.  Ask for a boatload of information, and go from there.
        Important things to consider.
        The reserved space is 13 bytes long now in the following format:
        Assuming that the extraNonce starts at byte 130:
        |130-133|134-137|138-141|142-145|
        |minerNonce/extraNonce - 4 bytes|instanceId - 4 bytes|clientPoolNonce - 4 bytes|clientNonce - 4 bytes|
        This is designed to allow a single block template to be used on up to 4 billion poolSlaves (clientPoolNonce)
        Each with 4 billion clients. (clientNonce)
        While being unique to this particular pool thread (instanceId)
        With up to 4 billion clients (minerNonce/extraNonce)
        Overkill?  Sure.  But that's what we do here.  Overkill.
         */

        // Set this.blob equal to the BT blob that we get from upstream.
        this.blob = template.blocktemplate_blob;
        this.idHash = crypto.createHash('md5').update(template.blocktemplate_blob).digest('hex');
        // Set this.diff equal to the known diff for this block.
        this.difficulty = template.difficulty;
        // Set this.height equal to the known height for this block.
        this.height = template.height;
        // Set this.reserveOffset to the byte location of the reserved offset.
        this.reserveOffset = template.reserved_offset;
        // Set this.buffer to the binary decoded version of the BT blob.
        this.buffer = new Buffer(this.blob, 'hex');
        // Copy the Instance ID to the reserve offset + 4 bytes deeper.  Copy in 4 bytes.
        instanceId.copy(this.buffer, this.reserveOffset + 4, 0, 3);
        // Generate a clean, shiny new buffer.
        this.previous_hash = new Buffer(32);
        // Copy in bytes 7 through 39 to this.previous_hash from the current BT.
        this.buffer.copy(this.previous_hash, 0, 7, 39);
        // Reset the Nonce. - This is the per-miner/pool nonce
        this.extraNonce = 0;
        // The clientNonceLocation is the location at which the client pools should set the nonces for each of their clients.
        this.clientNonceLocation = this.reserveOffset + 12;
        // The clientPoolLocation is for multi-thread/multi-server pools to handle the nonce for each of their tiers.
        this.clientPoolLocation = this.reserveOffset + 8;
        if (template.seed_hash) {
            this.seedHash = Buffer.from(template.seed_hash, 'hex');
        } else {
            this.seedHash = Buffer.from('00', 'hex');
        }
        this.nextBlob = function () {
            // Write a 32 bit integer, big-endian style to the 0 byte of the reserve offset.
            this.buffer.writeUInt32BE(++this.extraNonce, this.reserveOffset);
            // Convert the blob into something hashable.
            return global.coinFuncs.convertBlob(this.buffer).toString('hex');
        };
        // Make it so you can get the raw block blob out.
        this.nextBlobWithChildNonce = function () {
            // Write a 32 bit integer, big-endian style to the 0 byte of the reserve offset.
            this.buffer.writeUInt32BE(++this.extraNonce, this.reserveOffset);
            // Don't convert the blob to something hashable.  You bad.
            return this.buffer.toString('hex');
        };
    };

    this.cryptoNight = function (convertedBlob) {
        return multiHashing.cryptonight(convertedBlob, convertedBlob[0] >= 8 ? 8 : 1);
    }
}

module.exports = TariCoin;
