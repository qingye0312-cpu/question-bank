use question_bank::{
    db::{self, Query, Store},
    exchange,
    model::*,
};
use serde_json::json;
use std::{path::PathBuf, time::Instant};
const TOPICS: [&str; 20] = [
    "组件布局",
    "窗口管理",
    "状态更新",
    "网络通信",
    "数据存储",
    "文件读写",
    "页面导航",
    "通知服务",
    "多端部署",
    "权限校验",
    "动画效果",
    "输入事件",
    "列表滚动",
    "资源加载",
    "生命周期",
    "表单编辑",
    "中文检索",
    "代码规范",
    "离线发布",
    "数据恢复",
];
fn main() {
    if let Err(e) = run() {
        eprintln!("{e}");
        std::process::exit(1)
    }
}
fn run() -> Result<()> {
    let args: Vec<_> = std::env::args().collect();
    match args.get(1).map(String::as_str) {
        Some("benchmark-ocr") => {
            let path = PathBuf::from(args.get(2).ok_or("缺少合成性能库路径")?);
            if !path.exists() { return Err("性能库不存在".into()); }
            let store = Store::open(&path)?;
            let banks = store.banks()?;
            if banks.len()!=1 || !banks[0].name.starts_with("性能验证 ·") { return Err("仅允许使用独立的合成性能库".into()); }
            let bank = &banks[0];
            let connection = store.conn()?;
            let mut samples=Vec::new();
            let fuzzy = args.get(3).map(String::as_str) == Some("--fuzzy");
            for i in 0..if fuzzy { 5 } else { 20 } {
                let offset = i * 7919 % bank.count;
                let data:String=connection.query_row("SELECT data FROM questions WHERE bank_id=?1 AND deleted=0 ORDER BY rowid LIMIT 1 OFFSET ?2",rusqlite::params![bank.id,offset],|r|r.get(0)).map_err(err)?;
                let q:Question=serde_json::from_str(&data).map_err(err)?;
                let text=format!("{}\n{}",q.stem,q.options.iter().map(|o|format!("{}. {}",o.key,o.content)).collect::<Vec<_>>().join("\n"));
                let text=if fuzzy { text.replacen("场景", "场最", 1) } else { text };
                let result=question_bank::ocr::matching::find(&store,&bank.id,&text)?;
                eprintln!("OCR match {}/{}: {:.2} ms",i+1,if fuzzy {5}else{20},result.elapsed_ms);
                samples.push(json!({"expected":q.external_id,"first":result.candidates.first().map(|c|&c.hit.question.external_id),"automatic":result.automatic,"elapsed_ms":result.elapsed_ms}));
            }
            let mut times:Vec<f64>=samples.iter().filter_map(|s|s["elapsed_ms"].as_f64()).collect();times.sort_by(f64::total_cmp);
            println!("{}",serde_json::to_string_pretty(&json!({"questions":bank.count,"cases":samples.len(),"mode":if fuzzy {"one character substitution"}else{"exact text"},"top1":samples.iter().filter(|s|s["expected"]==s["first"]).count(),"p95_ms":percentile(&times,0.95),"max_ms":times.last(),"measures":"OCR text matching only; synthetic questions; excludes recognition and UI; OS cache uncontrolled","samples":samples})).map_err(err)?);
        }
        Some("ocr") => {
            let image = question_bank::ocr::image_file(&PathBuf::from(args.get(2).ok_or("缺少图片路径")?))?;
            let recognition = question_bank::ocr::recognize(&image.data_url)?;
            let dir = tempfile::tempdir().map_err(err)?;
            let store = Store::open(dir.path().join("ocr.sqlite"))?;
            store.seed()?;
            let bank = store.banks()?.remove(0);
            let matches = question_bank::ocr::matching::find(&store, &bank.id, &recognition.text)?;
            println!("{}", serde_json::to_string_pretty(&json!({"recognition":recognition,"matches":matches})).map_err(err)?);
        }
        Some("export-seed") => {
            let dir = tempfile::tempdir().map_err(err)?;
            let store = Store::open(dir.path().join("seed.sqlite"))?;
            store.seed()?;
            let out = PathBuf::from(args.get(2).ok_or("缺少输出目录")?);
            std::fs::create_dir_all(&out).map_err(err)?;
            let bank = store.banks()?.remove(0);
            for (format, ext) in [("package", "qbank.zip"), ("jsonl", "jsonl")] {
                exchange::export(
                    &store,
                    &bank.id,
                    &out.join(format!("HarmonyOS初级认证_v1.{ext}")),
                    format,
                )?;
            }
            println!(
                "{}",
                json!({"total":bank.count,"review":bank.review_count,"output":out})
            );
        }
        Some("inspect") => {
            let dir = tempfile::tempdir().map_err(err)?;
            let store = Store::open(dir.path().join("inspect.sqlite"))?;
            let p = exchange::preview(
                &store,
                &PathBuf::from(args.get(2).ok_or("缺少文件路径")?),
                "",
            )?;
            println!("{}", serde_json::to_string_pretty(&p.preview).map_err(err)?);
            if !p.preview.errors.is_empty() {
                return Err("文件未通过校验".into());
            }
        }
        Some("remeasure") => {
            let path=PathBuf::from(args.get(2).ok_or("缺少基准库路径")?);
            if !path.exists(){return Err("基准库不存在".into());}
            let store=Store::open(&path)?;let banks=store.banks()?;
            if banks.len()!=1 || !banks[0].name.starts_with("性能验证 ·") {return Err("仅允许测量独立的合成性能库".into());}
            let bank=&banks[0];
            let mut report:serde_json::Value=serde_json::from_slice(&std::fs::read(path.with_extension("report.json")).map_err(err)?).map_err(err)?;
            if report["questions"].as_i64()!=Some(bank.count){return Err("基准库数量已变化".into());}
            report.as_object_mut().unwrap().extend(measure(&store,&bank.id,bank.count as usize)?.as_object().unwrap().clone());
            report["remeasured_at"]=json!(now());
            std::fs::write(path.with_extension("remeasured.report.json"),serde_json::to_vec_pretty(&report).map_err(err)?).map_err(err)?;
            println!("{}",serde_json::to_string_pretty(&report).map_err(err)?);
        }
        Some("benchmark") => {
            let n: usize = args.get(2).ok_or("缺少题数")?.parse().map_err(err)?;
            if n==0 {return Err("题数必须大于零".into());}
            let path = PathBuf::from(args.get(3).ok_or("缺少数据库路径")?);
            if path.exists() {
                return Err("基准库已存在，请使用新路径以免覆盖".into());
            }
            benchmark(n, path)?;
        }
        _ => {
            return Err(
                "用法：qbank-tool export-seed 输出目录 | inspect 文件 | benchmark 题数 数据库路径 | remeasure 已有基准库路径 | ocr 图片路径 | benchmark-ocr 合成性能库路径 [--fuzzy]"
                    .into(),
            )
        }
    }
    Ok(())
}
fn percentile(v: &[f64], p: f64) -> f64 {
    v[((v.len() - 1) as f64 * p).ceil() as usize]
}
fn benchmark(n: usize, path: PathBuf) -> Result<()> {
    let store = Store::open(&path)?;
    let bank = store.create(&format!("性能验证 · {n} 题"))?;
    let examples: Vec<Question> =
        serde_json::from_str(include_str!("../../resources/examples.json")).map_err(err)?;
    let topics = TOPICS;
    let t = Instant::now();
    let mut c = store.conn()?;
    let tx = c.transaction().map_err(err)?;
    let mut chars = 0;
    let mut max_chars = 0;
    let mut digest = sha2::Sha256::new();
    use sha2::Digest;
    for i in 0..n {
        let mut q = examples[i % 3].clone();
        q.prepare();
        q.external_id = format!("BENCH-{i:07}");
        q.bank = format!("性能验证 · {n} 题");
        let a = topics[i % 20];
        let b = topics[(i / 20) % 20];
        q.stem=format!("任务{i:07}：在{a}场景下处理{b}，编号{} 的数据如何正确保存？\n代码：@Component.service{:03}.run({}); // =value + 1\n请考虑中文与 Unicode、错误返回、连续更新和用户取消操作的情况。{}",i*13,i%251,i*7919%104729,if i%7==0{"冷门标记 Ωξ，媒体查询宽度阈值与应用窗口尺寸。"}else{"保持本地数据与检索结果一致。"});
        q.tags = vec![a.into(), b.into()];
        q.chapter = format!("章节/{}", i % 37);
        q.explanation = format!(
            "样本序号 {i}，参数 seed={}。这是性能合成数据，不作为知识答案使用。",
            i * 97
        );
        let len = q.search_text().chars().count();
        chars += len;
        max_chars = max_chars.max(len);
        digest.update(q.search_text().as_bytes());
        db::insert(&tx, &bank, &q)?;
    }
    tx.commit().map_err(err)?;
    c.execute_batch("INSERT INTO search_tri(search_tri) VALUES('optimize'); INSERT INTO search_short(search_short) VALUES('optimize'); PRAGMA wal_checkpoint(TRUNCATE);").map_err(err)?;
    let build_seconds = t.elapsed().as_secs_f64();
    let mut report = json!({"questions":n,"build_seconds":build_seconds,"database_bytes":std::fs::metadata(&path).map_err(err)?.len(),"total_search_characters":chars,"average_search_characters":chars as f64/n as f64,"maximum_search_characters":max_chars,"search_corpus_sha256":format!("{:x}",digest.finalize())});
    report
        .as_object_mut()
        .unwrap()
        .extend(measure(&store, &bank, n)?.as_object().unwrap().clone());
    let output = path.with_extension("report.json");
    std::fs::write(&output, serde_json::to_vec_pretty(&report).map_err(err)?).map_err(err)?;
    println!("{}", serde_json::to_string_pretty(&report).map_err(err)?);
    Ok(())
}

fn measure(store: &Store, bank: &str, n: usize) -> Result<serde_json::Value> {
    let topics = TOPICS;
    let mut queries = Vec::new();
    for i in 0..200 {
        let text = match i % 10 {
            0 => "中".into(),
            1 => topics[(i / 10) % 20].chars().take(2).collect(),
            2 => format!("service{:03}", i % 251),
            3 => format!("任务{:07}", i * 499 % n),
            4 => match (i / 10) % 4 {
                0 => format!("{} {}", topics[i / 10 % 20], topics[(i / 10 + 3) % 20]),
                1 => format!("中 service{:03}", i % 251),
                2 => "Ωξ @Component".into(),
                _ => "罕 @Component".into(),
            },
            5 => "不存在的关键词零命中".into(),
            6 => "@Component".into(),
            7 => "Ωξ".into(),
            8 => "=value".into(),
            _ => format!("BENCH-{:07}", i * 401 % n),
        };
        queries.push(Query {
            text,
            bank_id: if i % 4 == 0 {
                bank.to_string()
            } else {
                String::new()
            },
            kind: if i % 7 == 0 {
                "single".into()
            } else {
                String::new()
            },
            ..Default::default()
        });
    }
    let initial = queries
        .iter()
        .map(|q| store.search(q).map(|r| r.elapsed_ms))
        .collect::<Result<Vec<_>>>()?;
    let mut times = Vec::new();
    let mut checks = 0;
    for round in 0..3 {
        for j in 0..queries.len() {
            let q = &queries[(j * 73 + round * 19) % queries.len()];
            let r = store.search(q)?;
            let terms = db::query_terms(&normalize(&q.text));
            for h in &r.items {
                if !terms.iter().all(|t| h.question.search_text().contains(t)) {
                    return Err(format!("检索返回错误结果：{}", q.text));
                }
                checks += 1;
            }
            times.push(r.elapsed_ms);
        }
    }
    let mut first = initial;
    first.sort_by(f64::total_cmp);
    times.sort_by(f64::total_cmp);
    Ok(
        json!({"query_cases":queries.len(),"query_suite":"v2-mixed","search_strategy":"ordered-fts-stream","rounds":3,"returned_matches_checked":checks,"first_pass_os_cache_uncontrolled_ms":{"p50":percentile(&first,0.5),"p95":percentile(&first,0.95),"p99":percentile(&first,0.99)},"warm_core_ms":{"p50":percentile(&times,0.5),"p95":percentile(&times,0.95),"p99":percentile(&times,0.99),"max":times.last()},"measures":"Core query only; opens connection per query; includes hydration of first 50 records; OS cache not purged; UI not included","platform":std::env::consts::OS,"arch":std::env::consts::ARCH}),
    )
}
