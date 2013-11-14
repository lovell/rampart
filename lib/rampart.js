/**
 * rampart
 *
 * Reverse HTTP proxy backed by distributed memory cache.
 * Designed to protect APIs from intense GET request traffic spikes.
 * @author Lovell Fuller
 *
 * This code is distributed under the Apache License Version 2.0, the terms of
 * which may be found at http://www.apache.org/licenses/LICENSE-2.0.html
 */

var url = require("url");
var urlUtils = require("node-url-utils");
var cityhash = require("cityhash");
var async = require("async");
var httpProxy = require("http-proxy");
var mediaType = require("media-type");
var lruCache = require("lru-cache");
var Memcached = require("memcached");

// Map of media types, each with array of cacheable subtypes
var cacheableMediaTypes = {
  application: ["xml", "json", "javascript"],
  text: ["javascript", "xml", "css", "html", "plain"]
};

// Can we cache the media type specified by this Content-Type response header?
var isCacheable = function(contentType) {
  var cacheable = false;
  var type = mediaType.fromString(contentType);
  if (type.type in cacheableMediaTypes) {
    // Support "type/subtype" and "type/variant+subtype"
    cacheable = cacheableMediaTypes[type.type].indexOf(type.subtype) > -1 || 
      (type.hasSuffix() && cacheableMediaTypes[type.type].indexOf(type.suffix) > -1);
  }
  return cacheable;
};

// Generate cache key names
var cacheKey = function(parts) {
  return "rampart-" + parts.join("-");
};

// Parse TTL from a Cache-Control response header, in seconds, defaulting to 0
var ttlFromCacheControlHeader = function(headerValue) {
  var ttl = 0;
  // Cache-Control
  if (headerValue && headerValue.indexOf("no-cache") == -1 && headerValue.indexOf("private") == -1) {
    var smaxage = headerValue.match(/s-maxage=(\d+)/);
    if (smaxage) {
      ttl = smaxage[1];
    } else {
      var maxage = headerValue.match(/max-age=(\d+)/);
      if (maxage) {
        ttl = maxage[1];
      }
    }
  }
  return ttl;
};

// Normalise URL
var normaliseUrlCache = lruCache(1000);
var normaliseUrl = function(rawUrl, removeKeys) {
  var normaliseUrl = normaliseUrlCache.get(rawUrl);
  if (!normaliseUrl) {
    normaliseUrl = url.parse(urlUtils.normalize(rawUrl, {
      removeKeys: removeKeys || []
    }));
    normaliseUrlCache.set(rawUrl, normaliseUrl);
  }
  return normaliseUrl;
};

exports.createServer = function(options) {
  var server;
  if (options.upstream && options.memcached && options.port) {

    // Configure memcached client
    var memcached = new Memcached(options.memcached);
    memcached.on("failure", function(details) {
      console.dir(details);
    });

    // Handle requests
    server = httpProxy.createServer(function(req, res, proxy) {
      // Normalise path
      var upstreamUrl = normaliseUrl(options.upstream + req.url, options.removeKeys);
      req.url = upstreamUrl.path;
      // Hash URL to generate cache key segment
      var key = cityhash.hash64(req.url).value;
      // Fetch data from memcached
      async.parallel({
        data: function(callback) {
          memcached.get(cacheKey([key, "data"]), callback);
        },
        meta: function(callback) {
          memcached.get(cacheKey([key, "meta"]), callback);
        },
        lock: function(callback) {
          memcached.get(cacheKey([key, "lock"]), callback);
        }
      }, function(err, cache) {
        var cacheHit = false;
        var isUpdating = false;
        if (!err) {
          if (cache.meta && cache.data) {
            var maxage = cache.meta.e - Date.now();
            if (maxage > 0 || cache.lock) {
              // Cache still valid or lock held by another request
              var headers = {
                date: (new Date()).toUTCString(),
                connection: "keep-alive",
                "content-type": cache.meta.t,
                "content-length": cache.data.length,
                "x-rampart": cache.lock ? "stale" : "hit"
              };
              if (maxage > 0) {
                headers["cache-control"] = "max-age=" + Math.ceil(maxage / 1000);
              }
              if (cache.meta.s) {
                headers.server = cache.meta.s;
              }
              if (cache.meta.ce) {
                headers["content-encoding"] = cache.meta.ce;
              }
              if (cache.meta.etag) {
                headers.etag = cache.meta.etag;
              }
              res.writeHead(200, headers);
              res.end(cache.data);
              cacheHit = true;
            } else {
              memcached.set(cacheKey([key, "lock"]), true);
              isUpdating = true;
            }
          }
        } else {
          console.log(err);
        }
        if (!cacheHit) {
          // Cache miss - proxy upstream
          proxy.proxyRequest(req, res, {
            host: upstreamUrl.hostname,
            port: upstreamUrl.port || 80,
            changeOrigin: true,
            enable: {
              xforward: true
            }
          });
          res.setHeader("x-rampart", isUpdating ? "updating" : "miss");
        }
      });
    }).listen(options.port);

    // Handle upstream responses
    server.proxy.on("proxyResponse", function(req, res, response) {
      // Can we cache this response?
      if (response.statusCode === 200 && "content-type" in response.headers && "cache-control" in response.headers) {
        if (isCacheable(response.headers["content-type"])) {
          var ttl = ttlFromCacheControlHeader(response.headers["cache-control"]);
          if (ttl > 0) {
            var data = "";
            response.on("data", function(chunk) {
              data = data + chunk;
            });
            response.on("end", function() {
              // Only cache responses <1MB
              if (data.length < 1048576) {
                var key = cityhash.hash64(req.url).value;
                var meta = {
                  e: ttl * 1000 + Date.now(),
                  t: response.headers["content-type"],
                  u: req.url
                };
                if ("server" in response.headers) {
                  meta.s = response.headers.server;
                }
                if ("content-encoding" in response.headers) {
                  meta.ce = response.headers["content-encoding"];
                }
                if ("etag" in response.headers) {
                  meta.etag = response.headers.etag;
                }
                // Update cache
                // NB: Use of series means some clients may be sent new data with old headers
                async.series([
                  function(callback) {
                    memcached.set(cacheKey([key, "data"]), data, 0, callback);
                  },
                  function(callback) {
                    memcached.set(cacheKey([key, "meta"]), meta, 0, callback);
                  },
                  function(callback) {
                    memcached.del(cacheKey([key, "lock"]));
                    callback(null);
                  }
                ], function(err) {
                  if (err) {
                    console.log(err);
                  }
                });
              }
            });
          }
        }
      }
    });
  }
  return server;
};
