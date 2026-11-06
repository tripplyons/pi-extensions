//! Fuzzy name matching for quick pickers, such as the composer's project search.

/// Scores `candidate` against `query` when every query character appears in
/// order, ignoring case and whitespace in the query. Higher is better. Matches
/// at the start of the name or of a word, and consecutive matches, score more.
/// An empty query matches everything with a score of 0.
pub fn score(query: &str, candidate: &str) -> Option<i32> {
    let query: Vec<char> = query
        .chars()
        .filter(|c| !c.is_whitespace())
        .flat_map(char::to_lowercase)
        .collect();
    if query.is_empty() {
        return Some(0);
    }
    let chars: Vec<char> = candidate.chars().collect();
    let mut score = 0;
    let mut next = 0;
    let mut previous: Option<usize> = None;
    for wanted in query {
        let found = (next..chars.len()).find(|&i| chars[i].to_lowercase().eq([wanted]))?;
        score += 1;
        if previous.is_some_and(|p| p + 1 == found) {
            score += 5;
        }
        if found == 0 || !chars[found - 1].is_alphanumeric() {
            score += 8;
        }
        // Earlier gaps cost a little, so tighter matches rank first.
        score -= (found - next).min(10) as i32;
        previous = Some(found);
        next = found + 1;
    }
    Some(score)
}

/// Indices of `names` that match `query`, best first. Equal scores keep the
/// original order.
pub fn rank<'a>(query: &str, names: impl IntoIterator<Item = &'a str>) -> Vec<usize> {
    let mut scored: Vec<(usize, i32)> = names
        .into_iter()
        .enumerate()
        .filter_map(|(index, name)| score(query, name).map(|score| (index, score)))
        .collect();
    scored.sort_by(|a, b| b.1.cmp(&a.1));
    scored.into_iter().map(|(index, _)| index).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_letters_in_order_ignoring_case() {
        assert!(score("pxt", "pi-extensions").is_some());
        assert!(score("PE", "pi-extensions").is_some());
        assert!(score("txp", "pi-extensions").is_none());
        assert!(score("pi ext", "pi-extensions").is_some());
        assert_eq!(score("", "anything"), Some(0));
    }

    #[test]
    fn ranks_word_starts_and_runs_first() {
        let names = ["campaign", "api-desk", "pi-desk"];
        assert_eq!(rank("pd", names), vec![2, 1]);
        assert_eq!(rank("desk", names), vec![2, 1]);
        assert_eq!(rank("", names), vec![0, 1, 2]);
    }
}
