//! `cosine_ranking`: exact float32 cosine top-k with the kernel of server/src/matcher.ts (`dot`
//! accumulating in f64, `TopK` sorted insertion, batches of 1,000), over `float32-embeddings-v1`.

use crate::measure::{RecordInput, sample, seeded_random, to_record};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

const BATCH_SIZE: usize = 1_000;

struct Batch {
    ids: Vec<String>,
    vectors: Vec<f32>,
}

/// Unit vectors exactly as `fixture` in scripts/benchmark-matching.ts builds them: the norm
/// sums the generated f64 values, then each stored f32 is divided by it.
fn unit_vectors(next: &mut impl FnMut() -> f64, count: usize, dimension: usize) -> Vec<f32> {
    let mut values = vec![0f32; count * dimension];
    for row in values.chunks_mut(dimension) {
        let mut sum = 0.0;
        for value in row.iter_mut() {
            let generated = next();
            *value = generated as f32;
            sum += generated * generated;
        }
        let norm = sum.sqrt();
        row.iter_mut().for_each(|value| *value = (f64::from(*value) / norm) as f32);
    }
    values
}

pub fn dot(query: &[f32], vector: &[f32]) -> f64 {
    query.iter().zip(vector).fold(0.0, |sum, (q, v)| sum + f64::from(*q) * f64::from(*v))
}

/// Best `k` so far, highest first; offers arrive in ascending ID order, so ties keep the lower ID.
struct TopK<'a> {
    ids: Vec<&'a str>,
    scores: Vec<f64>,
    k: usize,
}

impl<'a> TopK<'a> {
    fn offer(&mut self, id: &'a str, score: f64) {
        if self.scores.len() == self.k && score <= self.scores[self.k - 1] {
            return;
        }
        let mut at = self.scores.len();
        while at > 0 && score > self.scores[at - 1] {
            at -= 1;
        }
        self.ids.insert(at, id);
        self.scores.insert(at, score);
        if self.ids.len() > self.k {
            self.ids.pop();
            self.scores.pop();
        }
    }
}

fn rank<'a>(query: &[f32], directory: &'a [Batch], k: usize) -> Vec<&'a str> {
    let mut best = TopK {
        ids: Vec::with_capacity(k + 1),
        scores: Vec::with_capacity(k + 1),
        k,
    };
    for batch in directory {
        for (row, id) in batch.ids.iter().enumerate() {
            best.offer(id, dot(query, &batch.vectors[row * query.len()..(row + 1) * query.len()]));
        }
    }
    best.ids
}

/// Full-sort reference with the same products; ties break on the lower ID.
fn reference<'a>(query: &[f32], directory: &'a [Batch], k: usize) -> Vec<&'a str> {
    let mut scored: Vec<(&str, f64)> = directory
        .iter()
        .flat_map(|batch| {
            batch
                .ids
                .iter()
                .enumerate()
                .map(|(row, id)| (id.as_str(), dot(query, &batch.vectors[row * query.len()..(row + 1) * query.len()])))
        })
        .collect();
    scored.sort_by(|x, y| y.1.total_cmp(&x.1).then_with(|| x.0.cmp(y.0)));
    scored.into_iter().take(k).map(|(id, _)| id).collect()
}

fn measure(job: &Value, phase: &str, queries: &[&[f32]], directory: &[Batch], verify: usize, fixture_sha256: &str) -> Value {
    let k = job["top_k"].as_u64().unwrap() as usize;
    let mut rankings = Vec::with_capacity(queries.len());
    let run = sample(queries.len(), 0.0, |i| rankings.push(rank(queries[i], directory, k)));
    let checked = verify.min(queries.len());
    let errors = (0..checked).filter(|&i| reference(queries[i], directory, k) != rankings[i]).count();
    let parameters =
        json!({ "directory_size": job["size"], "dimension": job["dimension"], "top_k": k, "candidate_batch_size": BATCH_SIZE, "verified_queries": checked });
    let input = RecordInput {
        workload_id: "cosine_ranking",
        phase,
        fixture_sha256: fixture_sha256.to_string(),
        concurrency: 1.0,
        errors,
        checked,
        dropped_samples: 0,
        parameters,
    };
    to_record(job, &run, input)
}

/// Cold (first query) and steady (remaining queries) records, like `runCosineBenchmark`.
pub fn run(job: &Value) -> Vec<Value> {
    let [size, dimension, count, verify] = ["size", "dimension", "queries", "verify"].map(|key| job[key].as_u64().unwrap() as usize);
    let mut next = seeded_random(job["seed"].as_u64().unwrap() as u32);
    let directory: Vec<Batch> = (0..size.div_ceil(BATCH_SIZE))
        .map(|b| {
            let ids: Vec<String> = (b * BATCH_SIZE..size.min((b + 1) * BATCH_SIZE)).map(|row| format!("{row:09}")).collect();
            let vectors = unit_vectors(&mut next, ids.len(), dimension);
            Batch { ids, vectors }
        })
        .collect();
    let query_values = unit_vectors(&mut next, count, dimension);
    let mut hash = Sha256::new();
    directory
        .iter()
        .map(|batch| &batch.vectors)
        .chain([&query_values])
        .flatten()
        .for_each(|value| hash.update(value.to_le_bytes()));
    let fixture_sha256 = crate::measure::hex(&hash.finalize());
    let queries: Vec<&[f32]> = query_values.chunks(dimension).collect();
    let mut records = vec![measure(job, "cold", &queries[..1], &directory, verify, &fixture_sha256)];
    if queries.len() > 1 {
        records.push(measure(job, "steady", &queries[1..], &directory, verify.saturating_sub(1), &fixture_sha256));
    }
    records
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn top_k_keeps_the_lower_id_on_ties_and_matches_the_reference() {
        let mut best = TopK {
            ids: vec![],
            scores: vec![],
            k: 2,
        };
        [("a", 0.5), ("b", 0.9), ("c", 0.5), ("d", 0.7)]
            .into_iter()
            .for_each(|(id, score)| best.offer(id, score));
        assert_eq!(best.ids, vec!["b", "d"]);
        let directory = vec![Batch {
            ids: vec!["0".into(), "1".into(), "2".into()],
            vectors: vec![1.0, 0.0, 0.6, 0.8, 0.6, 0.8],
        }];
        assert_eq!(rank(&[0.0, 1.0], &directory, 2), reference(&[0.0, 1.0], &directory, 2));
        assert_eq!(rank(&[0.0, 1.0], &directory, 2), vec!["1", "2"]);
    }
}
