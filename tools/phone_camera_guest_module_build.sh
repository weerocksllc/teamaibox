#!/bin/sh
set -eu
# Google's modules_prepare archive contains x86 host tools. Rebuild the two
# tools this non-exporting module uses, from the matching kernel sources.
# Leave the guest configuration, generated headers and symbol CRCs unchanged.
src=/work/kernel/common
out=/work/out
gcc -O2 -Wall -I"$src/scripts/include" -o "$out/scripts/basic/fixdep" "$src/scripts/basic/fixdep.c"
gcc -O2 -Wall -I"$out/scripts/mod" -I"$src/scripts/mod" \
    -I"$src/scripts/include" -o "$out/scripts/mod/modpost" \
    "$src/scripts/mod/modpost.c" "$src/scripts/mod/file2alias.c" \
    "$src/scripts/mod/sumversion.c" "$src/scripts/mod/symsearch.c"
exec "$@"
