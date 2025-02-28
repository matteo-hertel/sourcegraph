package shared

import "github.com/sourcegraph/sourcegraph/monitoring/monitoring"

var CodeInsights codeInsights

var namespace string = "codeinsights"

// codeInsights provides `CodeInsights` implementations.
type codeInsights struct{}

// src_insights_search_queue_total
// src_insights_search_queue_processor_total
func (codeInsights) NewInsightsQueryRunnerQueueGroup(containerName string) monitoring.Group {
	return Queue.NewGroup(containerName, monitoring.ObservableOwnerCodeInsights, QueueSizeGroupOptions{
		GroupConstructorOptions: GroupConstructorOptions{
			Namespace:       namespace,
			DescriptionRoot: "Query Runner Queue",
			Hidden:          true,

			ObservableConstructorOptions: ObservableConstructorOptions{
				MetricNameRoot:        "insights_search_queue",
				MetricDescriptionRoot: "code insights search queue",
			},
		},

		QueueSize: NoAlertsOption("none"),
		QueueGrowthRate: NoAlertsOption(`
			This value compares the rate of enqueues against the rate of finished jobs.

				- A value < than 1 indicates that process rate > enqueue rate
				- A value = than 1 indicates that process rate = enqueue rate
				- A value > than 1 indicates that process rate < enqueue rate
		`),
	})
}

// src_insights_search_queue_processor_total
// src_insights_search_queue_processor_duration_seconds_bucket
// src_insights_search_queue_processor_errors_total
// src_insights_search_queue_processor_handlers
func (codeInsights) NewInsightsQueryRunnerWorkerGroup(containerName string) monitoring.Group {
	return Workerutil.NewGroup(containerName, monitoring.ObservableOwnerCodeInsights, WorkerutilGroupOptions{
		GroupConstructorOptions: GroupConstructorOptions{
			Namespace:       namespace,
			DescriptionRoot: "insights queue processor",
			Hidden:          true,

			ObservableConstructorOptions: ObservableConstructorOptions{
				MetricNameRoot:        "insights_search_queue",
				MetricDescriptionRoot: "handler",
			},
		},

		SharedObservationGroupOptions: SharedObservationGroupOptions{
			Total:     NoAlertsOption("none"),
			Duration:  NoAlertsOption("none"),
			Errors:    NoAlertsOption("none"),
			ErrorRate: NoAlertsOption("none"),
		},
		Handlers: NoAlertsOption("none"),
	})
}

// src_insights_search_queue_resets_total
// src_insights_search_queue_reset_failures_total
// src_insights_search_queue_reset_errors_total
func (codeInsights) NewInsightsQueryRunnerResetterGroup(containerName string) monitoring.Group {

	return WorkerutilResetter.NewGroup(containerName, monitoring.ObservableOwnerCodeInsights, ResetterGroupOptions{
		GroupConstructorOptions: GroupConstructorOptions{
			Namespace:       namespace,
			DescriptionRoot: "code insights search queue record resetter",
			Hidden:          true,

			ObservableConstructorOptions: ObservableConstructorOptions{
				MetricNameRoot:        "insights_search_queue",
				MetricDescriptionRoot: "insights search queue",
			},
		},

		RecordResets:        NoAlertsOption("none"),
		RecordResetFailures: NoAlertsOption("none"),
		Errors:              NoAlertsOption("none"),
	})
}

func (codeInsights) NewInsightsQueryRunnerStoreGroup(containerName string) monitoring.Group {
	return Observation.NewGroup(containerName, monitoring.ObservableOwnerCodeInsights, ObservationGroupOptions{
		GroupConstructorOptions: GroupConstructorOptions{
			Namespace:       namespace,
			DescriptionRoot: "dbstore stats",
			Hidden:          true,

			ObservableConstructorOptions: ObservableConstructorOptions{
				MetricNameRoot:        "workerutil_dbworker_store_insights_query_runner_jobs_store",
				MetricDescriptionRoot: "store",
				By:                    []string{"op"},
			},
		},

		SharedObservationGroupOptions: SharedObservationGroupOptions{
			Total:     NoAlertsOption("none"),
			Duration:  NoAlertsOption("none"),
			Errors:    NoAlertsOption("none"),
			ErrorRate: NoAlertsOption("none"),
		},
		Aggregate: &SharedObservationGroupOptions{
			Total:     NoAlertsOption("none"),
			Duration:  NoAlertsOption("none"),
			Errors:    NoAlertsOption("none"),
			ErrorRate: NoAlertsOption("none"),
		},
	})
}
