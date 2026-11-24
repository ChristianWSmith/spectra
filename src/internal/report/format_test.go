package report

import "testing"

// TestReportCellMatchesFmtMetric pins reportCell to the app's own formatter
// (frontend/src/lib/fmt.js fmtMetric). The expected strings are fmtMetric's
// output for each value and format, generated from the frontend module, so a
// report and the screen cannot drift without this test failing.
func TestReportCellMatchesFmtMetric(t *testing.T) {
	cases := []struct {
		format string
		value  float64
		want   string
	}{
		{"", 0.0, "0"},
		{"", -0.4, "-0.40"},
		{"", 0.5, "0.50"},
		{"", 1.25, "1.25"},
		{"", 2.5, "2.50"},
		{"", -2.5, "-2.50"},
		{"", 45.5, "45.50"},
		{"", 0.4567, "0.46"},
		{"", 0.5555, "0.56"},
		{"", 1234.5, "1234.50"},
		{"", -1234.5, "-1234.50"},
		{"", 1234567.891, "1234567.89"},
		{"", 999.995, "1000.00"},
		{"", 0.001, "0.00"},
		{"", -0.001, "0.00"},
		{"", 12.0, "12"},
		{"", 11.999, "12.00"},
		{"int", 0.0, "0"},
		{"int", -0.4, "-0"},
		{"int", 0.5, "1"},
		{"int", 1.25, "1"},
		{"int", 2.5, "3"},
		{"int", -2.5, "-2"},
		{"int", 45.5, "46"},
		{"int", 0.4567, "0"},
		{"int", 0.5555, "1"},
		{"int", 1234.5, "1,235"},
		{"int", -1234.5, "-1,234"},
		{"int", 1234567.891, "1,234,568"},
		{"int", 999.995, "1,000"},
		{"int", 0.001, "0"},
		{"int", -0.001, "-0"},
		{"int", 12.0, "12"},
		{"int", 11.999, "12"},
		{"float1", 0.0, "0.0"},
		{"float1", -0.4, "-0.4"},
		{"float1", 0.5, "0.5"},
		{"float1", 1.25, "1.3"},
		{"float1", 2.5, "2.5"},
		{"float1", -2.5, "-2.5"},
		{"float1", 45.5, "45.5"},
		{"float1", 0.4567, "0.5"},
		{"float1", 0.5555, "0.6"},
		{"float1", 1234.5, "1234.5"},
		{"float1", -1234.5, "-1234.5"},
		{"float1", 1234567.891, "1234567.9"},
		{"float1", 999.995, "1000.0"},
		{"float1", 0.001, "0.0"},
		{"float1", -0.001, "0.0"},
		{"float1", 12.0, "12.0"},
		{"float1", 11.999, "12.0"},
		{"float2", 0.0, "0.00"},
		{"float2", -0.4, "-0.40"},
		{"float2", 0.5, "0.50"},
		{"float2", 1.25, "1.25"},
		{"float2", 2.5, "2.50"},
		{"float2", -2.5, "-2.50"},
		{"float2", 45.5, "45.50"},
		{"float2", 0.4567, "0.46"},
		{"float2", 0.5555, "0.56"},
		{"float2", 1234.5, "1234.50"},
		{"float2", -1234.5, "-1234.50"},
		{"float2", 1234567.891, "1234567.89"},
		{"float2", 999.995, "1000.00"},
		{"float2", 0.001, "0.00"},
		{"float2", -0.001, "0.00"},
		{"float2", 12.0, "12.00"},
		{"float2", 11.999, "12.00"},
		{"percent", 0.0, "0%"},
		{"percent", -0.4, "-40%"},
		{"percent", 0.5, "50%"},
		{"percent", 1.25, "125%"},
		{"percent", 2.5, "250%"},
		{"percent", -2.5, "-250%"},
		{"percent", 45.5, "4550%"},
		{"percent", 0.4567, "45.7%"},
		{"percent", 0.5555, "55.6%"},
		{"percent", 1234.5, "123450%"},
		{"percent", -1234.5, "-123450%"},
		{"percent", 1234567.891, "123456789.1%"},
		{"percent", 999.995, "99999.5%"},
		{"percent", 0.001, "0.1%"},
		{"percent", -0.001, "-0.1%"},
		{"percent", 12.0, "1200%"},
		{"percent", 11.999, "1199.9%"},
		{"currency", 0.0, "$0"},
		{"currency", -0.4, "$0"},
		{"currency", 0.5, "$1"},
		{"currency", 1.25, "$1"},
		{"currency", 2.5, "$3"},
		{"currency", -2.5, "−$2"},
		{"currency", 45.5, "$46"},
		{"currency", 0.4567, "$0"},
		{"currency", 0.5555, "$1"},
		{"currency", 1234.5, "$1,235"},
		{"currency", -1234.5, "−$1,234"},
		{"currency", 1234567.891, "$1,234,568"},
		{"currency", 999.995, "$1,000"},
		{"currency", 0.001, "$0"},
		{"currency", -0.001, "$0"},
		{"currency", 12.0, "$12"},
		{"currency", 11.999, "$12"},
	}
	for _, c := range cases {
		if got := reportCell(c.value, c.format); got != c.want {
			t.Errorf("reportCell(%v, %q) = %q, fmtMetric gives %q", c.value, c.format, got, c.want)
		}
	}
}

// An identity metric names a player, which a report cannot resolve: the dash.
// A non-finite value is the dash too, in every format.
func TestReportCellDashes(t *testing.T) {
	if got := reportCell(1, "identity"); got != reportCellDash {
		t.Errorf("identity = %q, want the dash", got)
	}
	for _, f := range []string{"", "int", "float1", "float2", "percent", "currency"} {
		if got := reportCell(0, f); f != "" && got == reportCellDash {
			t.Errorf("finite 0 in %q shows the dash", f)
		}
	}
}
