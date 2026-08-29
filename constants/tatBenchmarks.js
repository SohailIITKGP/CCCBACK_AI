/** Shared SLA benchmarks — aligned with reportController TAT reports */
const TAT_BENCHMARK_DAYS = {
  leadToClient: 1,
  clientToOpportunity: 2,
  tagDefault: 3,
};

const TAT_TAG_BENCHMARK_DAYS = {
  Approved: 5,
  LOI: 10,
  Agreement: 14,
  Win: 21,
  Reject: 7,
  "Planning for Site Visit": 3,
  "Site Visit Done": 7,
  "Site-visit-Positive": 5,
  "Site-visit-Negative": 5,
};

function tagBenchmarkDays(tag) {
  return TAT_TAG_BENCHMARK_DAYS[tag] != null
    ? TAT_TAG_BENCHMARK_DAYS[tag]
    : TAT_BENCHMARK_DAYS.tagDefault;
}

module.exports = {
  TAT_BENCHMARK_DAYS,
  TAT_TAG_BENCHMARK_DAYS,
  tagBenchmarkDays,
};
