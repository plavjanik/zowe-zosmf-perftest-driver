zztop
=====

Zowe z/OSMF Test of Performance

[![oclif](https://img.shields.io/badge/cli-oclif-brightgreen.svg)](https://oclif.io)
[![Version](https://img.shields.io/npm/v/@zowedev/zztop.svg)](https://npmjs.org/package/@zowedev/zztop)
[![CircleCI](https://circleci.com/gh/plavjanik/zowe-zosmf-perftest-driver/tree/master.svg?style=shield)](https://circleci.com/gh/plavjanik/zowe-zosmf-perftest-driver/tree/master)
[![Downloads/week](https://img.shields.io/npm/dw/zztop.svg)](https://npmjs.org/package/zztop)
[![License](https://img.shields.io/npm/l/zztop.svg)](https://github.com/plavjanik/zowe-zosmf-perftest-driver/blob/master/package.json)

## Description

The purpose of this CLI tool is to generate workload for z/OSMF that is typical for Zowe CLI use cases.
It is configurable, you can specify number of users, duration, and size of the data used during the tests.

The resource consumption on z/OS is not measured by this tool, you need to measure it on z/OS 
- all z/OSMF (IZU*) address space, CIM server, and all TSO sessions created for the test users.

Design document: <https://docs.google.com/document/d/1UEOSERYf7qSXGZY-w1aqI8kBfjweIRTk8zRKlBGbh_4/edit?usp=sharing>

## Requirements

- Node.js 12 and above on any platform (Linux, Windows, [z/OS](https://docs.zowe.org/stable/user-guide/install-nodejs-zos.html))

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
   
   Set the host and port to the values of the tested z/OSMF instance. Use a different profile name instead of `zzow01-zowep` for each user.

3. Create test definition file `test.json` - example:

    ```json
    {
      "name": "basic",
      "fileSize": "10k",
      "memberSize": "10k",
      "jobOutputSize": "10k",
      "duration": "5m",
      "commandDelay": "1s",
      "scriptDelay": "15s",
      "concurrentUsers": 10,
      "zosmfProfiles": ["zzow01-zowep"],
      "dsnSecondSegment": "ZZTOP",
      "unixDir": "/zaas1/zowep/zztop",
      "accountCode": "00000000",
      "jobCard": [
        "//$jobname JOB 000000000,'ZZTOP',MSGCLASS=A,CLASS=A,",
        "//  MSGLEVEL=(1,1),REGION=0M",
        "/*JOBPARM SYSAFF=*"
      ]   
    }
    ```
   
   Use same profile names as in the step #2. Their number can be lower than the number of concurrent users.
   Provide valid values for `jobCard`, `dsnSecondSegment` and `unixDir`.
   
   You can start with a short `duration` and lower number of `concurrentUsers` and then you can increase it e.g. 1 hour 
   and try to maximum amount of users.  
   
   Available time unit types are:
    
   - nanoseconds (ns)
   - microseconds (μs)
   - milliseconds (ms)
   - seconds (s, sec)
   - minutes (m, min)
   - hours (h, hr)
   - days (d)
   - weeks (w, wk)
   - months
   - years (y, yr)   

4. Run it:

    ```bash
    PERF_TIMING_ENABLED=TRUE PERF_TIMING_IO_MAX_HISTORY=1 PERF_TIMING_IO_SAVE_DIR=. npx @zowedev/zztop test.json
    ```
   
5. Capture `requests.log`, `requests-error.log`, `metrics.1.json`, and the output of the command.   
