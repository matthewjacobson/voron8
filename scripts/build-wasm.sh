#!/usr/bin/env bash
# Compile the CGAL Segment Voronoi bindings to a single-file ES module
# (wasm embedded as base64) at src/core/voronoi.js. The output is committed so
# consumers never need Emscripten or CGAL to install the package.
set -euo pipefail

cd "$(dirname "$0")/.."

# Header locations. Override DEPS_INCLUDE_DIR to point at a custom CGAL/Boost
# install; otherwise we discover Homebrew's.
CGAL_INC="${CGAL_INCLUDE_DIR:-$(brew --prefix cgal)/include}"
BOOST_INC="${BOOST_INCLUDE_DIR:-$(brew --prefix boost)/include}"

echo "CGAL  headers: $CGAL_INC"
echo "Boost headers: $BOOST_INC"

mkdir -p src/core

emcc cpp/voronoi.cpp \
  -o src/core/voronoi.js \
  -std=c++17 \
  -O3 \
  -I"$CGAL_INC" \
  -I"$BOOST_INC" \
  -DCGAL_DISABLE_GMP=1 \
  -DCGAL_DISABLE_ROUNDING_MATH_CHECK=1 \
  -DBOOST_ALL_NO_LIB \
  --bind \
  -sMODULARIZE=1 \
  -sEXPORT_ES6=1 \
  -sSINGLE_FILE=1 \
  -sALLOW_MEMORY_GROWTH=1 \
  -sEXPORT_NAME=createVoron8Module \
  -sENVIRONMENT=web,worker,node \
  -sNO_DISABLE_EXCEPTION_CATCHING

echo "Built src/core/voronoi.js"
