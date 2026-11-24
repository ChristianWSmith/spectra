package report

import (
	"math"
	"strconv"
	"strings"

	"github.com/ChristianWSmith/spectra/internal/store"
)

// reportCell formats one FRESH stored value for a document with the rules
// fmtMetric applies on screen (frontend/src/lib/fmt.js), so a report and the
// app agree. A percent metric stores a 0..1 fraction; store.MetricDisplayScale
// turns it into percent first, as fmtMetric does. Each format rounds half up
// (JavaScript's Math.round), and the `identity` format has no name to show in a
// report, so it renders the dash.
func reportCell(v float64, format string) string {
	if format == "identity" {
		return reportCellDash
	}
	v *= store.MetricDisplayScale(format)
	if math.IsNaN(v) || math.IsInf(v, 0) {
		return reportCellDash
	}
	switch format {
	case "int":
		return groupDigits(intRound(v))
	case "float1":
		return strconv.FormatFloat(roundHalfUp(v, 1), 'f', 1, 64)
	case "float2":
		return strconv.FormatFloat(roundHalfUp(v, 2), 'f', 2, 64)
	case "percent":
		return strconv.FormatFloat(roundHalfUp(v, 1)+0, 'f', -1, 64) + "%"
	case "currency":
		n := roundHalfUp(v, 0)
		if n < 0 {
			return "−$" + groupDigits(-n)
		}
		return "$" + groupDigits(n)
	default:
		if v == math.Trunc(v) {
			return groupDigits(intRound(v))
		}
		return strconv.FormatFloat(roundHalfUp(v, 2), 'f', 2, 64)
	}
}

// roundHalfUp rounds x to places decimals the way JavaScript's Math.round does
// (ties toward +∞), so -2.5 rounds to -2. Its result is never negative zero:
// the fixed-point formatters print zero without a sign, as toFixed does.
func roundHalfUp(x float64, places int) float64 {
	p := math.Pow10(places)
	return math.Floor(x*p+0.5) / p
}

// intRound is roundHalfUp at zero places for the integer formats. A value that
// rounds to zero from below keeps the sign, as Math.round does (-0.4 → -0), and
// the locale formatter prints it: fmtInt shows "-0".
func intRound(x float64) float64 {
	n := roundHalfUp(x, 0)
	if n == 0 && (x < 0 || math.Signbit(x)) {
		return math.Copysign(0, -1)
	}
	return n
}

// groupDigits renders a whole number with ',' thousands separators (en-US, as
// the app's toLocaleString does). A negative number keeps the ASCII minus, and
// a negative zero keeps its sign too.
func groupDigits(x float64) string {
	neg := math.Signbit(x)
	digits := strconv.FormatInt(int64(math.Abs(x)), 10)
	var b strings.Builder
	if neg {
		b.WriteByte('-')
	}
	for i, c := range digits {
		if i > 0 && (len(digits)-i)%3 == 0 {
			b.WriteByte(',')
		}
		b.WriteRune(c)
	}
	return b.String()
}
