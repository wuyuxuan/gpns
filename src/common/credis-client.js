/***********************************************************************
 * <p>Title: redis client module</p>
 * <p>Description: sealing class for node-redis module, supplying utils method and attribution for redis client manipulation</p>
 * <p>Company: eraymobile </p>
 * @author  wubinhong
 * @version 1.0.0
 * @date    2014-04-24
 ***********************************************************************/
var util = require('util'), redis =require('node-redis');
var cNodeBase = require('./cnode-base'), pendingMsgPrefix = 'json:msg:';

var REDIS_SERVER_PORT = 6379,                     // redis servers listen port
    REDIS_SERVER_HOST = '192.168.1.4',         // redis servers remote host ip
//    REDIS_SERVER_HOST = '192.168.1.189',
    REDIS_SERVER_AUTH = null                     // redis servers auth info
/**
 * main
 * @constructor
 */
function RedisClient(port, host, auth) {
    cNodeBase.cNodeUtil.logger.info('Initializing redis client socket pool...' +
        'RedisClient [port -> %d, host -> %s, auth -> %s]', port, host, auth);
    this._redisClient = redis.createClient(port, host, auth);
}
util.inherits(RedisClient, cNodeBase.CNodeBase);
/**
 * get key for pending msg queue, key strategy: type:field:id.
 * for more detail, please refer: http://redis.io/topics/data-types-intro
 * @param key
 * @returns {string} eg. json:msg:key
 * @private
 */
RedisClient.prototype._getKey4PendingMsg = function (key) {
    return pendingMsgPrefix + key;
};
/**
 * end all socket in socket pool
 * @param cb
 */
RedisClient.prototype.end = function (cb) {
    this._redisClient.end(cb);
};
/**
 * get data from redis with key, only two types supported: json or string
 * @param key key stored in redis
 * @param cb asynchronous callback func with 2 parameters(err, data), which will be invoked when data retrieved from redis,
 * if buf stored in redis without json structure, data will be return as a string anyway
 * @param type [json]string], default json
 */
RedisClient.prototype.get = function (key, cb, type) {
    var thisObj = this;
    var client = thisObj._redisClient;
    client.get(key, function (err, buf) {
        thisObj.log('<== buf=%s', buf);
        if(type == 'string') {
            cb(err, buf);
            return;
        }
        try {
            cb(err, JSON.parse(buf));
        } catch(e) {
            thisObj.warn(e.stack);
            cb(err, buf);
        }
    });
};
/**
 * delete key-value pair in redis
 * @param key
 * @param cb callback func with 2 parameter(err, status), the status will return 0 or 1, meanning hit count
 */
RedisClient.prototype.del = function (key, cb) {
    this.log('==> del: key=%s', key);
    var thisObj = this;
    var client = thisObj._redisClient;
    client.del(key, function (err, status) {
        cb(err, status);
    });
};
/**
 * store data to redis with key, store code from redis will return to cb as the second parameter
 * @param key
 * @param expire values expire time in second
 * @param val data will stored in redis, only json and string data types supported
 * @param cb asynchronous callback func with 2 parameters(err, status)
 */
RedisClient.prototype.setex = function (key, expire, val, cb) {
    if(typeof val == 'object') val = JSON.stringify(val);
    this.log('==> setex: key=%s, val=%s', key, val);
    var thisObj = this;
    var client = thisObj._redisClient;
    client.setex(key, expire, val, function (err, status) {
        cb(err, status);
    });
};
/**
 * 往memcached中的pendingMsgMap队列中添加待推送消息，由客户端上线时触发获取，memcached中的pendingMsgMap格式如下：
 * {"pendingMsgMap_pushadd01":[{"id":1234,"type":1,"title":"天气提醒","content":"今天晴天，适合出游","detail":"<a>http:www.google.com</a>"}]}
 * @param msgPushAdds 要推送的消息实体和推送pushAdds，
 * 例如：{"pushAdds":["2","23","58"],"msg":{"id":1234,"type":1,"title":"天气提醒","content":"今天晴天，适合出游","detail":"<a>http:www.google.com</a>"},"expiredTime":1397728800000}
 * @param expiredTime 过期时间（second），如果不指定，则为 7*3600 second
 */
RedisClient.prototype.addPendingMsg = function (msgPushAdds, expiredTime) {
    var thisObj = this;
    if(!expiredTime) expiredTime = 25200;
    thisObj.loggerStack1.info('==> update pendingMsg queue in redis with msgPushAdds=%j, expiredTime=%d', msgPushAdds, expiredTime);
    for(var i=0; i<msgPushAdds.pushAdds.length; i++) {
        var pushAdd = msgPushAdds.pushAdds[i];
        var msg = msgPushAdds.msg;
        (function (pushAdd) {  // 闭包解决异步调用外部变量的问题（动态复制变量）https://github.com/BonsaiDen/JavaScript-Garden/blob/master/doc/zh/function/closures.md
            var key = thisObj._getKey4PendingMsg(pushAdd);
            thisObj.get(key, function (err, msgArr) {
                if(!msgArr) {
                    msgArr = new Array();
                }
                msgArr.push(msg);
                thisObj.setex(key, expiredTime, JSON.stringify(msgArr), function (err, status) {
                    thisObj.info('==> update pushAdd=%s, msgArr=%j, expiredTime=%d from pendingMsg queue in redis, err=%j, status=%j',
                        pushAdd, msgArr, expiredTime, err, status);
                });
            }, 'json');
        })(pushAdd);
    }
};
/**
 * get pending message queue in redis by pushAdd, callback will be invoke when catch value in redis,
 * @param pushAdd
 * @param callback callback func with params: err[Object], msgArr[Array],
 * for example: err=undefined, msgArr=[{"id":1234,"type":1,"title":"天气提醒","content":"今天晴天，适合出游","detail":"<a>http:www.google.com</a>"}]
 * @param remain optional, remain msg queue in redis or not, when invoke callback func, default false
 */
RedisClient.prototype.getPendingMsgQueue = function (pushAdd, callback, remain) {
    var thisObj = this;
    var key = thisObj._getKey4PendingMsg(pushAdd);
    thisObj.get(key, function (err, msgArr) {
        if(msgArr) {
            var len = msgArr.length;
            for (var i = 0; i < len; i++) {
                var msg = msgArr.shift();
                if (!(msg.expiredTime < new Date().getTime())) msgArr.push(msg);
            }
            if(!remain) {
                thisObj.del(key, function (err, status) {
                    thisObj.info('==> delete msgArr=%s from pendingMsg queue in redis, err=%j, status=%j',
                        pushAdd, err, status);
                });
            }
        }
        if(callback) callback(err, msgArr);
    }, 'json');
};

exports.RedisClient = RedisClient;
exports.redisClient = new RedisClient(REDIS_SERVER_PORT, REDIS_SERVER_HOST, REDIS_SERVER_AUTH);