package main

// version is the release this binary was built from. CI overwrites this
// file with the dispatch run's version input on release builds; pull
// request builds and local builds keep "dev", which never update-checks
// and is what GetVersion() surfaces in the UI.
//
// This file must stay stamp-only: the stamp step in ci.yml replaces its
// entire contents. The value feeds the updater's CurrentVersion — the
// release tag it is compared against must be the same string.
var version = "dev"
