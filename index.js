'use strict';

// native node modules
var util = require('util'),
  events = require('events');

// 3rd party modules
var _ = require('lodash'),
  async = require('async'),
  OniyiRequestor = require('oniyi-requestor');

// local variable definitions
var requestValidParameters = [
  'headers',
  'auth',
  'pool',
  'timeout',
  'proxy',
  'strictSSL',
  'agentOptions',
  'jar',
  'tunnel',
  'proxyHeaderWhiteList',
  'proxyHeaderExclusiveList',
  'forceJar',
  // cache related options
  'ttl',
  'disableCache',
  'storePrivate',
  'storeNoStore',
  'ignoreNoLastMod',
  'requestValidators',
  'responseValidators'
];

// local function definition

function putCookiesInJar(setCookieHeaders, completeRequestURI, cookieJar, callback) {
  if (typeof setCookieHeaders === 'string') {
    setCookieHeaders = [setCookieHeaders];
  }
  async.each(setCookieHeaders, function(setCookieHeader, callback) {
    cookieJar.setCookie(setCookieHeader, completeRequestURI, callback);
  }, callback);
}

function makeRequestCallback(responseBodyParser, callback) {
  var error;
  return function(err, response, body, passBackToCache) {
    if (err) {
      return callback(err, null);
    }

    passBackToCache = passBackToCache || _.noop;

    // (!(200 >= response.statusCode > 299))
    if (response.statusCode < 200 || response.statusCode > 299) {

      if (_.isPlainObject(body)) {
        error = new Error(JSON.stringify(body));
      } else {
        error = new Error(body);
      }

      error.httpStatus = response.statusCode;
      return callback(error, null);
    }

    // response was coming from cache and is parsed already
    if (response.fromCache && response.parsed) {
      return callback(null, response, JSON.parse(body));
    }

    // if no parser provided, just call back with raw response
    if (!_.isFunction(responseBodyParser)) {
      return callback(null, response, body);
    }

    // response has not been parsed yet, so let's do it
    var parsedResponseBody = responseBodyParser(body);

    // put the parsed response back to cache
    passBackToCache(null, JSON.stringify(parsedResponseBody), 'string');

    // finally resolve the deferred wiht our parsed responseBody
    response.parsed = true;
    return callback(null, response, parsedResponseBody);
  };
}

// the "class" definition
function OniyiRequestorClient(options) {
  var self = this;

  if (!_.isPlainObject(options)) {
    throw new TypeError('options need to be defined for OniyiRequestorClient');
  }

  options = _.merge({
    redis: {
      host: 'localhost',
      port: 6379
    },
    requestor: {
      throttle: {},
      cache: {},
      disableCache: false,
      maxLockTime: 5000 // these are milliseconds
    },
    defaultRequestOptions: {
      headers: {},
      forceJar: false
    }
  }, options);

  // check if a requestor instance was provided
  if (!options.requestor instanceof OniyiRequestor) {
    self.requestor = options.requestor;
  } else {
    // ... if not, create one
    // provide only those options that are of any value for the requestor
    self.requestor = new OniyiRequestor(_.merge(options.requestor, _.pick(options, ['redis'])));
  }

  self.defaultRequestOptions = options.defaultRequestOptions;

  // become an event emitter
  events.EventEmitter.call(self);
}

util.inherits(OniyiRequestorClient, events.EventEmitter);

OniyiRequestorClient.prototype.getRequestOptions = function(options) {
  var self = this;
  var requestOptions = _.merge({}, self.defaultRequestOptions, _.pick(options, requestValidParameters));

  var authProvided;
  // provided authorization data as request header "Authorization" has highest priority
  if (requestOptions.headers && (requestOptions.headers.authorization || requestOptions.headers.Authorization)) {
    authProvided = true;
  } else if (_.isPlainObject(requestOptions.auth) && _.size(requestOptions.auth) > 0) {
    authProvided = true;
  } else if (_.isString(options.accessToken)) {
    requestOptions.auth = {
      bearer: options.accessToken
    };
    authProvided = true;
  }
  // remove cookie jar if authentication data was provided
  // @TODO: this is still experimental
  // --> have to find a way to deal with returned LtpaTokens on login-call
  // --> I'd think we shouldn't maintain cookie jar's for authentication purposes anymore
  // --> go with basic / bearer authentication only!
  // --> need handler for 401 in case of bearer token
  // --> might be an expired access token and subsequent refresh is required
  if (!!authProvided && !options.forceJar) {
    requestOptions = _.omit(requestOptions, 'jar');
  }

  return requestOptions;
};

OniyiRequestorClient.prototype.makeRequest = function(requestMethod, requestOptions, responseBodyParser, callback) {
  var self = this,
    jar = requestOptions.jar;


  var requestCallback = makeRequestCallback(responseBodyParser, callback);
  // when we only get three arguments, we assume that responseBodyParser is actually our callback
  if (!callback) {
    requestCallback = makeRequestCallback(null, jar, responseBodyParser);
  }

  // since "request" and thus "oniyi-requestor" don't work with asynchronous cookie stores, we need to handle these separately.
  if (jar && jar.store && !jar.store.synchronous) {
    return jar.getCookieString(requestOptions.uri, function(err, cookieString) {
      if (err) {
        return callback(err);
      }

      requestOptions.jar = null;
      requestOptions.headers = requestOptions.headers || {};
      requestOptions.headers.cookie = cookieString + ((requestOptions.headers.cookie) ? '; ' + requestOptions.headers.cookie : '');
      return self.requestor[requestMethod].call(self.requestor, requestOptions, function(err, response, body, passBackToCache) {
        if (err) {
          return requestCallback(err, response, body, passBackToCache);
        }
        if (response.headers && response.headers['set-cookie'] && response.request.uri.href) {
          return putCookiesInJar(response.headers['set-cookie'], response.request.uri.href, jar, function(err) {
						if (err) {
							console.log('an error occured when storing cookies in jar {%s}', jar.id);
						}          	
            return requestCallback(err, response, body, passBackToCache);
          });
        }

        return requestCallback(err, response, body, passBackToCache);
      });
    });
  }
  return self.requestor[requestMethod].call(self.requestor, requestOptions, requestCallback);
};

module.exports = OniyiRequestorClient;
