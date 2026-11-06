#!/bin/sh
# Runs a command as the leader of a new session, in place, so the pid its caller recorded is both the process and its
# group. util-linux's setsid does that here, because a background job is not a group leader. macOS has no setsid.
if command -v setsid >/dev/null 2>&1; then
  exec setsid "$@"
fi
exec perl -MPOSIX -e 'POSIX::setsid(); exec { $ARGV[0] } @ARGV or die "cannot run $ARGV[0]: $!\n"' -- "$@"
