@echo off

set PERF_TIMING_ENABLED=TRUE
set PERF_TIMING_IO_MAX_HISTORY=1
set PERF_TIMING_IO_SAVE_DIR=.
node "%~dp0\run" %*
