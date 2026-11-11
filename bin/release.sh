#!/bin/sh

rsync -av --exclude='.git' --exclude='target' --exclude='node_modules'  ./ target/
