'use strict';

// native node modules
var util = require('util'),
	events = require('events');

// 3rd party modules
var _ = require('lodash'),
	oniyiRequestor = require('oniyi-requestor');

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
	if (!!options.requestor) {
		self.requestor = options.requestor;
	} else {
		// ... if not, create one
		// provide only those options that are of any value for the requestor
		self.requestor = new oniyiRequestor(_.merge(options.requestor, _.pick(options, ['redis', 'redisClient'])));
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
	// --> need handler for 401 in case of bearer toke
	// --> might be an expired access token and subsequent refresh is required
	if (!!authProvided && !options.forceJar) {
		requestOptions = _.omit(requestOptions, 'jar');
	}

	return requestOptions;
};

OniyiRequestorClient.prototype.makeRequest = function(requestMethod, requestOptions, responseBodyParser) {
	var self = this;
	var error;

	return self.requestor[requestMethod].call(self.requestor, requestOptions, function(err, response, body, passBackToCache) {
		if (err) {
			return requestOptions.callback(err, null);
		}

		passBackToCache = passBackToCache || _.noop;

		// (!(200 >= response.statusCode > 299))
		if (response.statusCode < 200 || response.statusCode > 299) {

			if (_.isPlainObject(body)) {
				error = new Error(JSON.stringify(body));
			} else {
				error = new Error(body);
			}

			error.status = response.statusCode;

			return requestOptions.callback(error, null);
		}

		// response was coming from cache and is parsed already
		if (response.fromCache && response.processed) {
			return requestOptions.callback(null, response, JSON.parse(body));
		}

		// if no parser provided, just call back with raw response
		if (!_.isFunction(responseBodyParser)) {
			return requestOptions.callback(null, response, body);
		}

		// response has not been processed yet, so let's do it
		var parsedResponseBody = responseBodyParser(body);

		// put the parsed response back to cache
		passBackToCache(null, JSON.stringify(parsedResponseBody), 'string');

		// finally resolve the deferred wiht our parsed responseBody
		response.processed = true;
		return requestOptions.callback(null, response, parsedResponseBody);
	});
};

module.exports = OniyiRequestorClient;