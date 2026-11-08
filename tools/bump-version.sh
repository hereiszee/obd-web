#!/bin/sh
# Usage: sh tools/bump-version.sh 1.0.2
# Stamps the version on every local file reference so browsers (and the GitHub Pages
# 10 minute cache) never mix files from two releases. Also sets APP_VERSION shown in the log.
set -e
V="$1"
[ -n "$V" ] || { echo "usage: $0 <version>"; exit 1; }
cd "$(dirname "$0")/.."
for f in js/*.js; do
  sed -i.bak -E "s#from '\./([a-z0-9-]+)\.js(\?v=[^']*)?'#from './\1.js?v=$V'#g" "$f"
done
sed -i.bak -E "s#var APP_VERSION = '[^']*'#var APP_VERSION = '$V'#" js/app.js
sed -i.bak -E "s#(href=\"css/app\.css)(\?v=[^\"]*)?\"#\1?v=$V\"#; s#(src=\"js/app\.js)(\?v=[^\"]*)?\"#\1?v=$V\"#" index.html
rm -f js/*.bak index.html.bak
grep -c "?v=$V" index.html js/*.js | grep -v ':0' || true
