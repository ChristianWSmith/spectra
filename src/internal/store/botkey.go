package store

import (
	"database/sql/driver"
	"strconv"

	sqlite "modernc.org/sqlite"

	"github.com/ChristianWSmith/spectra/internal/models"
)

// isBotKeyFunc is the SQL function that filters bots out of player reads.
// is_bot_key(steam_id) is 1 for a synthetic bot key and 0 for a human (or
// anything that is not a number, such as ”). Use it as
// `AND NOT is_bot_key(x.steam_id)` instead of joining players.is_bot.
const isBotKeyFunc = "is_bot_key"

func init() {
	// Registered on the driver before any connection opens, so every
	// store and query-only connection has it. Deterministic: no table reads.
	sqlite.MustRegisterDeterministicScalarFunction(isBotKeyFunc, 1, isBotKeySQL)
}

func isBotKeySQL(_ *sqlite.FunctionContext, args []driver.Value) (driver.Value, error) {
	if len(args) != 1 {
		return int64(0), nil
	}
	s, ok := args[0].(string)
	if !ok {
		return int64(0), nil
	}
	key, err := strconv.ParseUint(s, 10, 64)
	if err != nil {
		return int64(0), nil
	}
	if models.IsBotKey(key) {
		return int64(1), nil
	}
	return int64(0), nil
}
