# zztop

Zowe z/OSMF Test of Performance

[![oclif](https://img.shields.io/badge/cli-oclif-brightgreen.svg)](https://oclif.io)
[![Version](https://img.shields.io/npm/v/@zowedev/zztop.svg)](https://npmjs.org/package/@zowedev/zztop)
[![CircleCI](https://circleci.com/gh/plavjanik/zowe-zosmf-perftest-driver/tree/master.svg?style=shield)](https://circleci.com/gh/plavjanik/zowe-zosmf-perftest-driver/tree/master)
[![DeepScan grade](https://deepscan.io/api/teams/12096/projects/15061/branches/295161/badge/grade.svg)](https://deepscan.io/dashboard#view=project&tid=12096&pid=15061&bid=295161)
[![Downloads/week](https://img.shields.io/npm/dw/zztop.svg)](https://npmjs.org/package/zztop)
[![License](https://img.shields.io/npm/l/zztop.svg)](https://github.com/plavjanik/zowe-zosmf-perftest-driver/blob/master/package.json)

## Description

The purpose of this CLI tool is to generate workload for z/OSMF that is typical for Zowe CLI use cases.
It is configurable, you can specify number of users, duration, and size of the data used during the tests.

The resource consumption on z/OS is not measured by this tool, you need to measure it on z/OS

- all z/OSMF (IZU\*) address space, CIM server, and all TSO sessions created for the test users.

Design document: <https://docs.google.com/document/d/1UEOSERYf7qSXGZY-w1aqI8kBfjweIRTk8zRKlBGbh_4/edit?usp=sharing>

## Requirements

- Node.js 12 and above on any platform (Linux, Windows, [z/OS](https://docs.zowe.org/stable/user-guide/install-nodejs-zos.html))

## Usage

1. Initialize empty NPM project:

   ```bash
   mkdir zztop
   cd zztop
   npm init -y
   ```

2. Install package from NPM:

   ```bash
   npm i @zowedev/zztop
   ```

   Or you can clone this repository and run `npm install` in it.

   This installs Zowe CLI too locally in the repository.

3. Create Zowe profiles for each user ID that will be used for testing:

   Example:

   ```bash
   npx zowe profiles create zosmf-profile zzow01-zowep --host zzow01.zowe.marist.cloud --port 10443 --user userid --pass "passwd" --reject-unauthorized false --overwrite
   ```

   Set the host and port to the values of the tested z/OSMF instance. Use a different profile name instead of `zzow01-zowep` for each user.

4. Create test definition file `test.json` - example:

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

   Optionally, you can add `selectedTestNames` field which lists the subset of tests that will be executed:

   ```json
   "selectedTestNames": [
      "DatasetUpload",
      "DatasetDownload",
      "FileUpload",
      "FileDownload",
      "TsoCommand",
      "ConsoleCommand",
      "JobSubmit",
      "JobView",
      "JobDownload"
   ]
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

5. Run it:

   ```bash
   npx @zowedev/zztop test.json
   ```

   If you want to capture all debugging messages:

   ```bash
   npx @zowedev/zztop --logLevel debug test.json
   ```

6. Capture `zztop.log` log file.

7. Capture the z/OSMF log (see below)

8. Capture peformance data from RMF or using [Zowe Metrics Server](https://github.com/zowe/zowe-dependency-scan-pipeline/tree/master/performance/server)

## Capturing z/OSMF Logs

You need to login as user that has read access to `/var/zosmf/data/logs` or make them readable for your user ID by issuing these commands (only on server without sensitive data):

```sh
chmod a+rx /var/zosmf
chmod a+rx /var/zosmf/data
chmod -R a+rx /var/zosmf/data/logs
```

Then you can run on z/OS:

```
export JAVA_HOME="/sys/java64bt/v8r0m0/usr/lpp/java/J8.0_64"
$JAVA_HOME/bin/jar cvfM zosmf-logs.zip /var/zosmf/data/logs/*.log /var/zosmf/data/logs/zosmfServer/logs/
```

And download it:

```bash
zowe zos-files download uss-file <path>/zosmf-logs.zip --binary --zosmf-profile <profile-to-zosmf-system>
```

## Installing on z/OS

It has been tested with version 12.18.0 that has been installed following instructions in [Installing Node.js 12 on z/OS](https://levelup.gitconnected.com/installing-node-js-12-on-z-os-e5bf419826e6).

This is sample profile that sets the expected environment variables:

```sh
export NODE_DIR={node_dir}
export _BPXK_AUTOCVT=ON
export _CEE_RUNOPTS="FILETAG(AUTOCVT,AUTOTAG) POSIX(ON)"
export PATH=${NODE_DIR}/node-v12.18.0-os390-s390x/bin/:$PATH
```

The JSON files need to be tagged. If you have created JSON file in EBCDIC then it needs to be tagged by:

```sh
chtag -t -c IBM-1047 test.json
```

If it is in ASCII then you need:

```sh
chtag -t -c ISO8859-1 test.json
```
