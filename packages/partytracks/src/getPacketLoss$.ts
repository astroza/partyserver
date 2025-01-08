import { combineLatest, interval, map, pairwise, switchMap } from "rxjs";

import type { Observable } from "rxjs";

export interface PacketLossStats {
  inboundPacketLossPercentage: number;
  outboundPacketLossPercentage: number;
}

function statsReports$(
  peerConnection$: Observable<RTCPeerConnection>,
  statReportInterval = 3000
) {
  return combineLatest([peerConnection$, interval(statReportInterval)]).pipe(
    switchMap(([peerConnection]) => peerConnection.getStats()),
    pairwise()
  );
}

export function getPacketLoss$(
  peerConnection$: Observable<RTCPeerConnection>,
  tracks$: Observable<MediaStreamTrack[]>
) {
  return combineLatest([
    tracks$,
    peerConnection$,
    statsReports$(peerConnection$)
  ]).pipe(
    map(([tracks, peerConnection, [previousStatsReport, newStatsReport]]) => {
      const trackToMidMap = peerConnection
        .getTransceivers()
        .reduce((map, t) => {
          const track = t.sender.track ?? t.receiver.track;
          if (track !== null && t.mid !== null) {
            map.set(track, t.mid);
          }
          return map;
        }, new Map<MediaStreamTrack, string>());
      const relevantMids = new Set<string>();
      for (const track of tracks) {
        const mid = trackToMidMap.get(track);
        if (mid) {
          relevantMids.add(mid);
        }
      }
      let inboundPacketsReceived = 0;
      let inboundPacketsLost = 0;
      let outboundPacketsSent = 0;
      let outboundPacketsLost = 0;

      newStatsReport.forEach((report) => {
        if (!relevantMids.has(report.mid)) return;
        // @ts-expect-error RTCStatsReport types are busted
        const previous = previousStatsReport.get(report.id);
        if (!previous) return;

        if (report.type === "inbound-rtp") {
          inboundPacketsLost += report.packetsLost - previous.packetsLost;
          inboundPacketsReceived +=
            report.packetsReceived - previous.packetsReceived;
        } else if (report.type === "outbound-rtp") {
          const packetsSent = report.packetsSent - previous.packetsSent;
          // Find the corresponding remote-inbound-rtp report
          const remoteInboundReport = Array.from(
            // @ts-expect-error RTCStatsReport types are busted
            newStatsReport.values()
          ).find(
            // @ts-expect-error RTCStatsReport types are busted
            (r) => r.type === "remote-inbound-rtp" && r.ssrc === report.ssrc
          );
          const previousRemoteInboundReport = Array.from(
            // @ts-expect-error RTCStatsReport types are busted
            previousStatsReport.values()
          ).find(
            // @ts-expect-error RTCStatsReport types are busted
            (r) => r.type === "remote-inbound-rtp" && r.ssrc === previous.ssrc
          );
          if (
            remoteInboundReport &&
            previousRemoteInboundReport &&
            packetsSent > 0
          ) {
            outboundPacketsSent += report.packetsSent - previous.packetsSent;
            outboundPacketsLost +=
              // @ts-expect-error RTCStatsReport types are busted
              remoteInboundReport.packetsLost -
              // @ts-expect-error RTCStatsReport types are busted
              previousRemoteInboundReport.packetsLost;
          }
        }
      });

      const packetsLost = inboundPacketsLost + outboundPacketsLost;
      const packetsSent =
        inboundPacketsReceived + outboundPacketsSent + packetsLost;
      let packetLossPercentage = 0;

      if (packetsSent > 0) {
        packetLossPercentage = Math.max(0, packetsLost / packetsSent);
      }

      return packetLossPercentage;
    })
  );
}
