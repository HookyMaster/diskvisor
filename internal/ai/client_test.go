package ai

import "testing"

func TestParseAIEnums(t *testing.T) {
	for _, input := range []string{`{"safety":"<img src=x>","action":"execute"}`, `not json`} {
		r := &AnalysisResult{}
		parseAIContent(input, r)
		if r.Safety != "unknown" || r.Action != "unknown" {
			t.Fatalf("accepted invalid fields: %+v", r)
		}
	}
	r := &AnalysisResult{}
	parseAIContent(`{"safety":"caution","action":"keep"}`, r)
	if r.Safety != "caution" || r.Action != "keep" {
		t.Fatal("valid enums rejected")
	}
}
