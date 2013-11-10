/**
 * rampart
 * Integration tests
 *
 * This code is distributed under the Apache License Version 2.0, the terms of
 * which may be found at http://www.apache.org/licenses/LICENSE-2.0.html
 */
 
var assert = require("assert");
var http = require("http");
var request = require("request");
var portfinder = require("portfinder");
var SandboxedModule = require("sandboxed-module");

var stubCache = {};
var StubMemcached = function() {};
StubMemcached.prototype.get = function(key, callback) {
  callback(null, stubCache[key]);
};
StubMemcached.prototype.set = function(key, value, ttl, callback) {
  assert.strictEqual(ttl, 0);
  stubCache[key] = value;
  callback(null);
};
StubMemcached.prototype.del = function(key) {
  delete stubCache[key];
};
StubMemcached.prototype.on = function(event) {};

var rampart = SandboxedModule.require("../lib/rampart", {
  requires: {"memcached": StubMemcached}
});

// Find free port for upstream
portfinder.getPort(function (err, upstreamPort) {

  // Start upstream server
  console.log("Starting upstream server on port " + upstreamPort);
  http.createServer(function (req, res) {
    res.writeHead(200, {
      "Content-Type": "text/plain",
      "Cache-Control": "max-age=5"
    });
    res.end("hello: " + JSON.stringify(req.headers, null, 2));
  }).listen(upstreamPort);

  // Find free port for rampart
  portfinder.getPort(function (err, rampartPort) {

    // Start rampart proxy
    console.log("Starting rampart proxy on port " + rampartPort);
    var server = rampart.createServer({
      upstream: "http://127.0.0.1:" + upstreamPort,
      memcached: ["test"],
      port: rampartPort
    });

    server.on("listening", function() {
    
      // Fire request
      request("http://127.0.0.1:" + rampartPort + "/", function(err, res, body) {
        // Verify response
        assert.ok(err === null);
        assertCommonHeaders(res.headers);
        assert.strictEqual(res.headers["content-type"], "text/plain");
        assert.strictEqual(res.headers["x-rampart"], "miss");
        assert.strictEqual(Object.keys(stubCache).length, 2);
        process.exit();
      });
    });
  });
});

var assertCommonHeaders = function(headers) {
  assert.ok("date" in headers);
  assert.ok("connection" in headers);
  assert.ok("x-rampart" in headers);
  assert.strictEqual(headers.connection, "keep-alive");
};
