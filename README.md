zztop
=====

Zowe z/OSMF Test of Performance

[![oclif](https://img.shields.io/badge/cli-oclif-brightgreen.svg)](https://oclif.io)
[![Version](https://img.shields.io/npm/v/zztop.svg)](https://npmjs.org/package/zztop)
[![CircleCI](https://circleci.com/gh/plavjanik/zowe-zosmf-perftest-driver/tree/master.svg?style=shield)](https://circleci.com/gh/plavjanik/zowe-zosmf-perftest-driver/tree/master)
[![Downloads/week](https://img.shields.io/npm/dw/zztop.svg)](https://npmjs.org/package/zztop)
[![License](https://img.shields.io/npm/l/zztop.svg)](https://github.com/plavjanik/zowe-zosmf-perftest-driver/blob/master/package.json)

## Description

<https://docs.google.com/document/d/1UEOSERYf7qSXGZY-w1aqI8kBfjweIRTk8zRKlBGbh_4/edit?usp=sharing>

## Requirements

- Node.js 12 and above on any platform 

## Usage

1. Install package:

    ```bash
    npm i zztop.tgz
    ```

2. Create Zowe profiles:

    ```bash
    npx zowe profiles create zosmf-profile zzow01-zowep --host zzow01.zowe.marist.cloud --port 10443 --user userid --pass "passwd" --reject-unauthorized false --overwrite
    ```

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
      "dsnSecondSegment": "ZZTOP"
    }
    ```

4. Run it:

    ```bash
    PERF_TIMING_ENABLED=TRUE PERF_TIMING_IO_MAX_HISTORY=1 PERF_TIMING_IO_SAVE_DIR=. npx zztop test/testdef.json
    ```
