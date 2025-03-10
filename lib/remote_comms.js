"use strict";
const urllib = require('urllib');
const async = require('async');

function Database() {

    let thread_id='';

    this.sendQueue = async.queue(function (task, callback) {
        async.doUntil(
            function (intCallback) {
                urllib.request(global.config.general.shareHost, {method: 'POST', data: task.body}, function (error, body, response) {
                    if (!error) {
                        return intCallback(null, response.statusCode);
                    }
                    return intCallback(null, 0);
                });
            },
            function (data) {
                return data === 200;
            },
            function () {
                callback();
            });
    }, require('os').cpus().length*32);

    this.storeShare = function (blockId, shareData) {
        let wsData = global.protos.WSData.encode({
            msgType: global.protos.MESSAGETYPE.SHARE,
            key: global.config.api.authKey,
            msg: shareData,
            exInt: blockId
        });
        process.send({type: 'sendRemote', body: wsData.toString('hex')});
    };

    this.storeBlock = function (blockId, blockData) {
        let wsData = global.protos.WSData.encode({
            msgType: global.protos.MESSAGETYPE.BLOCK,
            key: global.config.api.authKey,
            msg: blockData,
            exInt: blockId
        });
        process.send({type: 'sendRemote', body: wsData.toString('hex')});
    };

    this.storeInvalidShare = function (minerData) {
        let wsData = global.protos.WSData.encode({
            msgType: global.protos.MESSAGETYPE.INVALIDSHARE,
            key: global.config.api.authKey,
            msg: minerData,
            exInt: 1
        });
        process.send({type: 'sendRemote', body: wsData.toString('hex')});
    };

    setInterval(function(queue_obj){
        if (global.database.thread_id === '(Master) '){
            console.log(global.database.thread_id + "Queue debug state: " + queue_obj.length() + " items in the queue " + queue_obj.running() + " items being processed");
        }
    }, 5000, this.sendQueue);


    this.initEnv = function(){
        this.data = null;
    };
}

module.exports = Database;