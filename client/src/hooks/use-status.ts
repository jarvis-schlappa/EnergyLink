import { useQuery } from "@tanstack/react-query";
import { queryClient } from "@/lib/queryClient";
import type { Settings, ControlState, PlugStatusTracking, ChargingContext, BuildInfo } from "@shared/schema";

/**
 * Consolidated status response from /api/status.
 * Replaces 5+ separate polling queries with a single request.
 */
export interface ConsolidatedStatus {
  settings: Settings;
  controls: ControlState;
  plugTracking: PlugStatusTracking;
  chargingContext: ChargingContext;
  e3dcLiveData: Record<string, unknown> | null;
  gridFrequency: Record<string, unknown> | null;
  buildInfo: BuildInfo;
  timestamp: string;
}

/**
 * Polls /api/status and distributes data into individual query caches
 * so existing components that read from ["/api/settings"] etc. still work.
 */
export function useStatus(refetchInterval = 5000) {
  return useQuery<ConsolidatedStatus>({
    queryKey: ["/api/status"],
    refetchInterval,
    refetchOnWindowFocus: true,
    staleTime: refetchInterval / 2,
    select: (data) => {
      // Distribute into individual caches for backwards compatibility
      if (data.settings) {
        queryClient.setQueryData(["/api/settings"], data.settings);
      }
      if (data.controls) {
        queryClient.setQueryData(["/api/controls"], data.controls);
      }
      if (data.plugTracking) {
        queryClient.setQueryData(["/api/wallbox/plug-tracking"], data.plugTracking);
      }
      if (data.chargingContext) {
        queryClient.setQueryData(["/api/charging/context"], data.chargingContext);
      }
      if (data.buildInfo) {
        queryClient.setQueryData(["/api/build-info"], data.buildInfo);
      }
      return data;
    },
  });
}
