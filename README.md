# rampart

Reverse HTTP proxy backed by distributed memory cache. Designed to protect APIs from intense GET request traffic spikes.

* HTTP reverse proxy
* Horizontally scalable
* Stateless instances
* Backed by a memcached cluster

_This is alpha-quality software and is not yet ready for use in production environments._

## Install

    npm install -g https://github.com/lovell/rampart/tarball/master

## Usage

    rampart --upstream host:port/path

### Command line options

#### Required

    --upstream   Upstream HTTP service to act as reverse proxy for in the form 'host:port/path'

#### Optional

    --memcached  Comma separated list of memcached hosts in the form 'host1:11211,host2:11211'
                 [default: "localhost:11211"]

    --port       TCP port for this service to listen on
                 [default: 8080]

    --metrics    TCP port on which to start HTTP service providing internal metrics as JSON

## Protection

* Avoids the thundering herd problem with a "[dogpile](https://bitbucket.org/zzzeek/dogpile.core)" lock
* Gracefully handles memcached node failure with [consistent hashing](http://en.wikipedia.org/wiki/Consistent_hashing)
* Can remove common client-side HTTP parameters, e.g. Google Analytics' utm_*
* Normalises variants of the same URL when generating the cache key
* Respects upstream HTTP Cache-Control response headers from the service it's protecting
* Ignores downstream HTTP Cache-Control request headers from the client
* TODO: Caches 4xx and 5xx responses

## Deployment

* TODO: Easy to deploy to AWS Elastic Beanstalk
* TODO: Supports AWS Elasticache's Auto Discovery feature
* TODO: Provides metrics e.g. requests per second, cache hit rates

## Current limitations

* Does not support HTTPS
* Does not respect the Vary response header
* One upstream per instance (but there can and should be many instances per upstream)

## Alternatives you should consider first

### nginx

nginx provides the proxy\_cache feature, where each instance maintains its own filesystem cache. Think of rampart as a distributed version of nginx's "[proxy_cache_use_stale updating](http://nginx.org/en/docs/http/ngx_http_proxy_module.html#proxy_cache_use_stale)" directive.

### squid

Versions 2.6 and 2.7 (the most recent release was 2010) of Squid provide a per-instance [Collapsed Forwarding](http://wiki.squid-cache.org/Features/CollapsedForwarding) feature to prevent the thundering herd problem. This feature is not available in version 3.x of Squid.

## Test [![Build Status](https://travis-ci.org/lovell/rampart.png?branch=master)](https://travis-ci.org/lovell/rampart)

Run the (currently very limited) integration tests with:

    npm test
