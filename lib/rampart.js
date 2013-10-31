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

var httpProxy = require("http-proxy");
var url = require("url");
var urlUtils = require("node-url-utils");
var cityhash = require("cityhash");
var async = require("async");
var Memcached = require("memcached");

var argv = require("optimist")
  .usage("Usage: $0")
  .demand(["upstream"])
  .default("memcached", "localhost:11211")
  .default("port", 8080)
  .describe("upstream", "Upstream HTTP service to act as reverse proxy for in the form 'host:port/path'")
  .describe("memcached", "Comma separated list of memcached hosts in the form 'host1:11211,host2:11211'")
  .describe("port", "TCP port for this service to listen on")
  .argv;

// Option: upstream hostname
var upstream = argv.upstream;
if (typeof upstream === "string" && upstream.length > 0) {
  // Ensure upstream includes the HTTP scheme
  var schemePrefix = "http://";
  if (upstream.substring(0, schemePrefix.length) !== schemePrefix) {
    upstream = schemePrefix + upstream;
  }
}

var cacheableMimeTypes = [
  "application/json", "application/ld+json", "application/javascript",
  "application/xml", "application/xhtml+xml", "application/rss+xml",
  "application/atom+xml", "text/javascript", "text/xml", "text/css",
  "text/html", "text/plain"
];

// Configure memcached client
var memcached = new Memcached(argv.memcached.split(","));
memcached.on('failure', function(details) {
  console.dir(details);
});

// Generate cache key names
var cacheKey = function(parts) {
  return "rampart-" + parts.join("-");
};

// Handle requests
var server = httpProxy.createServer(function(req, res, proxy) {
  // Normalise path
  var upstreamUrl = url.parse(urlUtils.normalize(upstream + req.url));
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
            "date": (new Date()).toUTCString(),
            "connection": "keep-alive",
            "server": cache.meta.s,
            "content-type": cache.meta.t,
            "content-length": cache.data.length,
            "x-rampart": cache.lock ? "stale" : "hit"
          };
          if (maxage > 0) {
            headers["cache-control"] = "max-age=" + Math.ceil(maxage / 1000);
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
}).listen(argv.port);

// Handle upstream responses
server.proxy.on("proxyResponse", function(req, res, response) {
  // Can we cache this reponse?
  if (response.statusCode === 200 && "content-type" in response.headers && "cache-control" in response.headers) {
    var contentType = response.headers["content-type"].split(";")[0];
    if (cacheableMimeTypes.indexOf(contentType) > -1) {
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
              's': response.headers.server,
              'e': ttl * 1000 + Date.now(),
              't': response.headers["content-type"],
              'u': req.url
            };
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

// Parse TTL (Time-To-Live) from the upstream response, in seconds, defaulting to 0
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
