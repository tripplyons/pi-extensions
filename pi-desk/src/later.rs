//! Snooze times for Later (L).

use chrono::{DateTime, Datelike, Duration, NaiveTime, TimeZone, Weekday};

/// A snooze time as local weekday and clock time, such as `Mon 09:00`.
pub fn clock(at: crate::model::Timestamp) -> String {
    DateTime::from_timestamp(at, 0)
        .map(|time| {
            time.with_timezone(&chrono::Local)
                .format("%a %H:%M")
                .to_string()
        })
        .unwrap_or_default()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Preset {
    Hour,
    Evening,
    Tomorrow,
    NextWeek,
}

impl Preset {
    pub const ALL: [Preset; 4] = [
        Preset::Hour,
        Preset::Evening,
        Preset::Tomorrow,
        Preset::NextWeek,
    ];

    pub fn label(self) -> &'static str {
        match self {
            Preset::Hour => "In an hour",
            Preset::Evening => "This evening (18:00)",
            Preset::Tomorrow => "Tomorrow (9:00)",
            Preset::NextWeek => "Next week (Monday 9:00)",
        }
    }
}

fn at<Tz: TimeZone>(day: DateTime<Tz>, hour: u32) -> DateTime<Tz> {
    let time = NaiveTime::from_hms_opt(hour, 0, 0).unwrap();
    let naive = day.date_naive().and_time(time);
    day.timezone()
        .from_local_datetime(&naive)
        .earliest()
        .unwrap_or(day)
}

pub fn preset<Tz: TimeZone>(preset: Preset, now: DateTime<Tz>) -> DateTime<Tz> {
    match preset {
        Preset::Hour => now + Duration::hours(1),
        Preset::Evening => {
            let evening = at(now.clone(), 18);
            if evening > now {
                evening
            } else {
                at(now + Duration::days(1), 18)
            }
        }
        Preset::Tomorrow => at(now + Duration::days(1), 9),
        Preset::NextWeek => {
            let days = 7 - now.weekday().num_days_from_monday() as i64;
            let monday = now + Duration::days(days);
            debug_assert_eq!(monday.weekday(), Weekday::Mon);
            at(monday, 9)
        }
    }
}

/// Accepts `30m`, `3h`, `2d`, or a clock time such as `14:30`, which means
/// today or, once passed, tomorrow.
pub fn parse<Tz: TimeZone>(input: &str, now: DateTime<Tz>) -> Option<DateTime<Tz>> {
    let input = input.trim().to_ascii_lowercase();
    if let Some((hours, minutes)) = input.split_once(':') {
        let time =
            NaiveTime::from_hms_opt(hours.trim().parse().ok()?, minutes.trim().parse().ok()?, 0)?;
        let today = now
            .timezone()
            .from_local_datetime(&now.date_naive().and_time(time))
            .earliest()?;
        return Some(if today > now {
            today
        } else {
            today + Duration::days(1)
        });
    }
    let split = input.find(|c: char| !c.is_ascii_digit())?;
    let amount: i64 = input[..split].parse().ok().filter(|amount| *amount > 0)?;
    let duration = match input[split..].trim() {
        "m" | "min" | "mins" | "minutes" => Duration::minutes(amount),
        "h" | "hr" | "hrs" | "hours" | "hour" => Duration::hours(amount),
        "d" | "day" | "days" => Duration::days(amount),
        _ => return None,
    };
    Some(now + duration)
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::FixedOffset;

    fn time(text: &str) -> DateTime<FixedOffset> {
        DateTime::parse_from_rfc3339(text).unwrap()
    }

    #[test]
    fn presets_land_on_the_next_matching_time() {
        let wednesday_noon = time("2026-11-04T12:00:00-08:00");
        assert_eq!(
            preset(Preset::Hour, wednesday_noon),
            time("2026-11-04T13:00:00-08:00")
        );
        assert_eq!(
            preset(Preset::Evening, wednesday_noon),
            time("2026-11-04T18:00:00-08:00")
        );
        assert_eq!(
            preset(Preset::Evening, time("2026-11-04T19:00:00-08:00")),
            time("2026-11-05T18:00:00-08:00")
        );
        assert_eq!(
            preset(Preset::Tomorrow, wednesday_noon),
            time("2026-11-05T09:00:00-08:00")
        );
        assert_eq!(
            preset(Preset::NextWeek, wednesday_noon),
            time("2026-11-09T09:00:00-08:00")
        );
        assert_eq!(
            preset(Preset::NextWeek, time("2026-11-09T08:00:00-08:00")),
            time("2026-11-16T09:00:00-08:00")
        );
    }

    #[test]
    fn custom_times_accept_durations_and_clock_times() {
        let now = time("2026-11-04T12:00:00-08:00");
        assert_eq!(parse("30m", now), Some(time("2026-11-04T12:30:00-08:00")));
        assert_eq!(parse("3 h", now), Some(time("2026-11-04T15:00:00-08:00")));
        assert_eq!(parse("2d", now), Some(time("2026-11-06T12:00:00-08:00")));
        assert_eq!(parse("14:30", now), Some(time("2026-11-04T14:30:00-08:00")));
        assert_eq!(parse("9:00", now), Some(time("2026-11-05T09:00:00-08:00")));
        assert_eq!(parse("soon", now), None);
        assert_eq!(parse("0h", now), None);
    }
}
