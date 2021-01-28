"use strict";
const db = require('./db');
const sql = require('./sql');
const {load: loadConfig} = require('./config');

const cnUtil = require('cryptoforknote-util');

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

const MERGE_MINING_ADDR_DELIM = ':';
const TARI_ADDRESS_REGEX = new RegExp("[0-9a-fA-F]{64}");

function tryParseMergeMiningAddress(addr) {
    const parts = addr.split(MERGE_MINING_ADDR_DELIM, 2);
    if (parts.length !== 2) {
        throw new Error("Invalid Tari merge mining address: did not contain 2 delimited addresses");
    }
    const [tari, monero] = parts;
    if (!isValidTariAddress(tari)) {
        throw new Error("Invalid Tari merge mining address: invalid characters or incorrect length");
    }
    if (!isValidMoneroAddress(monero)) {
        throw new Error("Invalid monero merge mining address: invalid characters or incorrect length");
    }

    return {
        tari,
        monero,
    };
}

function moneroAddressPrefixLengths(network) {
    switch (network) {
        case 'stagenet':
            return {
                prefix: 24,
                subPrefix: 36,
                integratedPrefix: 25,
            };

        case 'testnet':
            return {
                prefix: 53,
                subPrefix: 63,
                integratedPrefix: 54,
            };

        case 'mainnet':
            return {
                prefix: 18,
                subPrefix: 42,
                integratedPrefix: 19,
            };

        default:
            throw new Error(`Invalid network ${network} specified in config`);
    }
}

function isValidMoneroAddress(address) {
    const network = global.config.general.network;
    const {prefix, subPrefix, integratedPrefix} = moneroAddressPrefixLengths(network);
    const addrBuf = Buffer.from(address);
    let code = cnUtil.address_decode(addrBuf);
    if (code === prefix || code === subPrefix) {
        return true;
    }

    code = cnUtil.address_decode_integrated(addrBuf);
    return code === integratedPrefix;
}

function isValidTariAddress(address) {
    return TARI_ADDRESS_REGEX.test(address);
}

function toHex(bytes) {
    return Array.from(bytes, b => ('0' + b.toString(16)).slice(-2)).join('');
}

// Works for numbers and bignum
function compareGte(l, r) {
    if (typeof l === 'object') return l.ge(r);
    if (typeof r === 'object') return !r.lt(l);
    return l >= r;
}

module.exports = {
    loadConfig,
    db,
    sleep,
    tryParseMergeMiningAddress,
    toHex,
    compareGte,
    sql,
};
