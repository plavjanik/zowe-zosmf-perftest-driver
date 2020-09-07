zztop
=====

Zowe z/OSMF Test of Performance

[![oclif](https://img.shields.io/badge/cli-oclif-brightgreen.svg)](https://oclif.io)
[![Version](https://img.shields.io/npm/v/@zowedev/zztop.svg)](https://npmjs.org/package/@zowedev/zztop)
[![CircleCI](https://circleci.com/gh/plavjanik/zowe-zosmf-perftest-driver/tree/master.svg?style=shield)](https://circleci.com/gh/plavjanik/zowe-zosmf-perftest-driver/tree/master)
[![Downloads/week](https://img.shields.io/npm/dw/zztop.svg)](https://npmjs.org/package/zztop)
[![License](https://img.shields.io/npm/l/zztop.svg)](https://github.com/plavjanik/zowe-zosmf-perftest-driver/blob/master/package.json)

## Description

<https://docs.google.com/document/d/1UEOSERYf7qSXGZY-w1aqI8kBfjweIRTk8zRKlBGbh_4/edit?usp=sharing>

## Requirements

- Node.js 12 and above on any platform 

## Usage

1. Install package from NPM:

   ```bash
   npm i @zowedev/zztop
   ```
   
   Or you can clone this repository and run `npm install` in it.

2. Create Zowe profiles for each user ID that will be used for testing:

   Example:

   ```bash
   npx zowe profiles create zosmf-profile zzow01-zowep --host zzow01.zowe.marist.cloud --port 10443 --user userid --pass "passwd" --reject-unauthorized false --overwrite
   ```
   
   Set the host and port to the values of the tested z/OSMF instance.

3. Create test definition file `test.json`:

    ```json
    {
      "name": "basic",
      "fileSize": "10k",
      "memberSize": "10k",
      "jobOutputSize": "10k",
      "tsoCommandOutputSize": "1k",
      "duration": "15s",
      "commandDelay": "1s",
      "scriptDelay": "1s",
      "concurrentUsers": 5,
      "zosmfProfiles": ["zzow01-zowep"],
      "dsnSecondSegment": "ZZTOP",
      "unixDir": "/zaas1/zowep/zztop"
    }
    ```
   
   Use same profile names as in the step #2. Their number can be lower than the number of concurrent users.
   Provide valid values for `dsnSecondSegment` and `unixDir`.

4. Run it:

    ```bash
    PERF_TIMING_ENABLED=TRUE PERF_TIMING_IO_MAX_HISTORY=1 PERF_TIMING_IO_SAVE_DIR=. npx zztop test.json
    ```
   
5. Capture `requests.log`, `requests-error.log`, `metrics.1.json`, and the output of the command.   
