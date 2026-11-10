# Repo-root forwarder: the Wails/Go project lives in src/ (see AGENTS.md).
# Any target is forwarded to src/Makefile; command-line vars (ARGS=… etc.)
# and -s/-j propagate automatically via MAKEFLAGS.
.DEFAULT_GOAL := deps
%:
	$(MAKE) -C src $@
