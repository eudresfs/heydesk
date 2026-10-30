use super::{BatteryStatus, MemoryStatus};

#[derive(Clone, Copy)]
pub(super) struct CpuTimes { pub idle: u64, pub kernel: u64, pub user: u64 }

pub(super) fn cpu_percent(previous: Option<CpuTimes>, current: CpuTimes) -> Option<f64> {
    let previous = previous?;
    let idle = current.idle.checked_sub(previous.idle)?;
    let total = current.kernel.checked_sub(previous.kernel)?
        .checked_add(current.user.checked_sub(previous.user)?)?;
    if total == 0 || idle > total { return None; }
    Some((total - idle) as f64 * 100.0 / total as f64)
}

pub(super) fn memory_status(total: u64, available: u64) -> Option<MemoryStatus> {
    if total == 0 { return None; }
    Some(MemoryStatus { used_bytes: total.checked_sub(available)?, total_bytes: total })
}

// `ac`: ACLineStatus (0 fora, 1 na tomada, 255 desconhecido). Em 100% na tomada o
// Windows não marca "carregando"; só a linha AC diz que o carregador está ligado.
/// Bytes/s entre duas leituras dos contadores (entrada, saída). Contador que volta
/// (interface reiniciada) não vira taxa negativa nem pico absurdo.
pub(super) fn network_rate(previous: Option<((u64, u64), f64)>, current: ((u64, u64), f64)) -> Option<super::NetworkStatus> {
    let ((was_in, was_out), was_at) = previous?;
    let ((now_in, now_out), now_at) = current;
    let seconds = now_at - was_at;
    if seconds <= 0.05 || now_in < was_in || now_out < was_out { return None; }
    Some(super::NetworkStatus { down_bps: (now_in - was_in) as f64 / seconds, up_bps: (now_out - was_out) as f64 / seconds })
}

pub(super) fn battery_status(ac: u8, flags: u8, percent: u8) -> Option<BatteryStatus> {
    if flags == 255 { return None; }
    let has_battery = flags & 128 == 0;
    Some(BatteryStatus {
        percent: if has_battery && percent <= 100 { Some(percent as f64) } else { None },
        charging: has_battery && flags & 8 != 0,
        plugged: ac == 1,
        has_battery,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn cpu_requires_two_valid_samples() {
        let first = CpuTimes { idle: 100, kernel: 200, user: 100 };
        assert_eq!(cpu_percent(None, first), None);
        assert_eq!(cpu_percent(Some(first), first), None);
        let next = CpuTimes { idle: 150, kernel: 275, user: 125 };
        assert_eq!(cpu_percent(Some(first), next), Some(50.0));
        assert_eq!(cpu_percent(Some(next), first), None);
    }
    #[test]
    fn memory_reports_bytes_and_rejects_invalid_totals() {
        let memory = memory_status(16_000_000_000, 6_000_000_000).unwrap();
        assert_eq!(memory.used_bytes, 10_000_000_000);
        assert!(memory_status(0, 0).is_none());
        assert!(memory_status(100, 101).is_none());
    }
    #[test]
    fn network_rate_needs_two_samples_and_rejects_resets() {
        assert_eq!(network_rate(None, ((10, 10), 1.0)), None);
        let rate = network_rate(Some(((1_000, 500), 1.0)), ((3_000, 1_500), 3.0)).unwrap();
        assert_eq!((rate.down_bps, rate.up_bps), (1_000.0, 500.0));
        assert_eq!(network_rate(Some(((1_000, 500), 1.0)), ((10, 1_500), 2.0)), None);
    }
    #[test]
    fn battery_distinguishes_absence_and_unknown_percent() {
        assert!(battery_status(255, 255, 255).is_none());
        let absent = battery_status(1, 128, 255).unwrap();
        assert!(!absent.has_battery);
        assert_eq!(absent.percent, None);
        assert_eq!(battery_status(0, 1, 255).unwrap().percent, None);
        assert!(battery_status(1, 8, 50).unwrap().charging);
        assert_eq!(battery_status(0, 1, 0).unwrap().percent, Some(0.0));
        let full = battery_status(1, 1, 100).unwrap();
        assert!(full.plugged && !full.charging);
        assert!(!battery_status(0, 1, 80).unwrap().plugged);
    }
}
