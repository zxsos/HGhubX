use dom_query::{Document, Selection};
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::HashSet;
use std::time::Duration;

const MAX_HTML_BYTES: usize = 2 * 1024 * 1024;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(12);
const JS_MAX_SAFE_INTEGER: i64 = 9_007_199_254_740_991;
const DEFAULT_SSR_PAGE_SIZE: u32 = 39;
const PREVIEW_TRUNCATE_LIMIT: u32 = 20;

#[derive(Debug, Serialize)]
struct ChannelVideoCard {
    id: i64,
    title: String,
    cover: String,
    tags: Vec<String>,
    score: f64,
    episode_count: u32,
    total_episodes: u32,
    hot: u64,
    like_count: u64,
    collect_count: u64,
    comment_count: u64,
    is_finished: bool,
    is_original: u8,
    is_hot: u8,
    #[serde(skip_serializing_if = "Option::is_none")]
    new_at: Option<u64>,
}

fn normalized_string(value: &str) -> String {
    value.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn normalized_text(selection: Selection<'_>) -> String {
    normalized_string(&selection.text())
}

fn video_id_from_str(raw: &str) -> Option<i64> {
    let trimmed = raw.trim();
    if trimmed.is_empty() || !trimmed.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    let id = trimmed.parse::<i64>().ok()?;
    (id > 0 && id <= JS_MAX_SAFE_INTEGER).then_some(id)
}

fn video_id_from_href(href: &str) -> Option<i64> {
    let id = href.trim().strip_prefix("/video/")?.strip_suffix('/')?;
    video_id_from_str(id)
}

fn parse_score(raw: &str) -> f64 {
    let trimmed = raw.trim().trim_end_matches('分').trim();
    trimmed
        .parse::<f64>()
        .ok()
        .filter(|value| value.is_finite() && *value > 0.0)
        .unwrap_or(0.0)
}

fn first_u32_in_str(raw: &str) -> Option<u32> {
    let mut started = false;
    let mut value: u32 = 0;
    for ch in raw.chars() {
        if let Some(digit) = ch.to_digit(10) {
            started = true;
            value = value.saturating_mul(10).saturating_add(digit);
        } else if started {
            break;
        }
    }
    started.then_some(value)
}

fn parse_episode(raw: &str) -> (bool, u32, u32) {
    let text = normalized_string(raw);
    if text.is_empty() {
        return (false, 0, 0);
    }
    let finished = text.contains('全') || text.contains("完结");
    let count = if let Some(rest) = text.split("更新至").nth(1) {
        first_u32_in_str(rest)
    } else if let Some(rest) = text.split('全').nth(1) {
        first_u32_in_str(rest)
    } else {
        first_u32_in_str(&text)
    }
    .unwrap_or(0);
    let total = if finished { count } else { 0 };
    (finished, count, total)
}

fn parse_views(raw: &str) -> u64 {
    let text = raw.trim().replace(',', "");
    if text.is_empty() {
        return 0;
    }
    let lower = text.to_ascii_lowercase();
    let (num_part, multiplier) = if let Some(stripped) = lower.strip_suffix('w') {
        (stripped, 10_000.0)
    } else if let Some(stripped) = text.strip_suffix('万') {
        (stripped, 10_000.0)
    } else if let Some(stripped) = text.strip_suffix('亿') {
        (stripped, 100_000_000.0)
    } else {
        (lower.as_str(), 1.0)
    };
    let numeric: String = num_part
        .chars()
        .take_while(|ch| ch.is_ascii_digit() || *ch == '.')
        .collect();
    let parsed = numeric.parse::<f64>().ok().filter(|v| v.is_finite() && *v >= 0.0);
    parsed.map(|v| (v * multiplier).round() as u64).unwrap_or(0)
}

fn extract_cover(card: &Selection<'_>) -> String {
    let img = card.select(".hg-drama-card__cover img");
    if let Some(src) = img.attr("data-src") {
        let trimmed = src.trim();
        if !trimmed.is_empty() && !trimmed.contains("cover-placeholder") {
            return trimmed.to_string();
        }
    }
    if let Some(src) = img.attr("src") {
        let trimmed = src.trim();
        if !trimmed.is_empty() && !trimmed.contains("cover-placeholder") {
            return trimmed.to_string();
        }
    }
    String::new()
}

fn parse_channel_html(
    html: &str,
    panel: &str,
    page: u32,
    requested_size: u32,
) -> Result<Value, String> {
    let document = Document::from(html);
    let section = document.select("section.hg-channel-page");
    if section.is_empty() {
        return Err("官网频道页缺少频道主体区域".into());
    }

    let grid_selector = format!(".hg-card-grid[data-channel-panel=\"{panel}\"]");
    let grid = section.select(&grid_selector);
    if grid.is_empty() {
        return Err(format!("官网频道页缺少 {panel} 面板"));
    }
    if grid.attr("hidden").is_some() {
        return Err(format!("官网频道页 {panel} 面板处于隐藏状态"));
    }

    let panel_total = grid
        .attr("data-panel-total")
        .and_then(|value| value.trim().parse::<u64>().ok())
        .unwrap_or(0);

    let mut seen = HashSet::new();
    let mut items = Vec::new();
    for card_node in grid.select(".hg-drama-card").iter() {
        let card = Selection::from(card_node);
        let id = card
            .attr("data-track-id")
            .and_then(|value| video_id_from_str(&value))
            .or_else(|| {
                card.select(".hg-drama-card__cover-link")
                    .attr("href")
                    .and_then(|href| video_id_from_href(&href))
            })
            .or_else(|| {
                card.select(".hg-drama-card__title a")
                    .attr("href")
                    .and_then(|href| video_id_from_href(&href))
            });
        let Some(id) = id else {
            continue;
        };
        if !seen.insert(id) {
            continue;
        }

        let title = {
            let text = normalized_text(card.select(".hg-drama-card__title"));
            if !text.is_empty() {
                text
            } else {
                card.attr("data-track-title")
                    .map(|value| normalized_string(&value))
                    .unwrap_or_default()
            }
        };
        if title.is_empty() {
            continue;
        }

        let cover = extract_cover(&card);
        let score = parse_score(&normalized_text(card.select(".hg-drama-card__score")));
        let (is_finished, episode_count, total_episodes) =
            parse_episode(&normalized_text(card.select(".hg-drama-card__episode")));
        let hot = parse_views(&normalized_text(card.select(".hg-drama-card__views")));

        let mut tags = Vec::new();
        let mut seen_tags = HashSet::new();
        for tag_node in card.select(".hg-drama-card__tags .hg-tag").iter() {
            let tag = normalized_text(Selection::from(tag_node));
            if !tag.is_empty() && seen_tags.insert(tag.clone()) {
                tags.push(tag);
            }
        }

        let mut is_original: u8 = 0;
        let mut is_hot: u8 = 0;
        let mut new_at: Option<u64> = None;
        for badge_node in card.select(".hg-drama-card__badges .hg-drama-card__badge").iter() {
            let badge = Selection::from(badge_node);
            let class_attr = badge.attr("class").unwrap_or_default();
            let badge_text = normalized_string(&badge.text());
            if badge_text == "原创" {
                is_original = 1;
            } else if class_attr.contains("hg-drama-card__badge--hot") || badge_text == "热播" {
                is_hot = 1;
            } else if class_attr.contains("hg-drama-card__badge--new") || badge_text == "新片" {
                let parsed = badge
                    .attr("data-new-at")
                    .and_then(|value| value.trim().parse::<u64>().ok())
                    .filter(|value| *value > 0);
                new_at = Some(parsed.unwrap_or(1));
            }
        }

        items.push(ChannelVideoCard {
            id,
            title,
            cover,
            tags,
            score,
            episode_count,
            total_episodes,
            hot,
            like_count: 0,
            collect_count: 0,
            comment_count: 0,
            is_finished,
            is_original,
            is_hot,
            new_at,
        });
    }

    if items.is_empty() {
        return Err(format!("官网频道页 {panel} 面板没有可用条目"));
    }

    let full_page_len = items.len() as u32;
    let mut pages = section
        .select(".hg-pager__jump")
        .attr("data-pages")
        .and_then(|value| value.trim().parse::<u32>().ok())
        .filter(|value| *value > 0)
        .unwrap_or(0);

    if pages == 0 {
        for pager_link in section.select(".hg-pager a.hg-pager__page, .hg-pager span.hg-pager__page").iter() {
            if let Ok(num) = normalized_text(Selection::from(pager_link)).parse::<u32>() {
                if num > pages {
                    pages = num;
                }
            }
        }
    }

    let total = panel_total.max(items.len() as u64);
    if pages == 0 {
        let per_page = full_page_len.max(DEFAULT_SSR_PAGE_SIZE) as u64;
        pages = ((total + per_page - 1) / per_page).max(page as u64) as u32;
    }

    // 仅分类总览预览行（page=1 且 size < 20）按需截断；频道分页页保留整页卡片，
    // 防止官网每页 39 条在前端翻到第 2 页时跳过第 21..39 条。
    if page == 1 && requested_size > 0 && requested_size < PREVIEW_TRUNCATE_LIMIT {
        items.truncate(requested_size as usize);
    }

    let response_size = items.len() as u32;
    Ok(json!({
        "items": items,
        "pagination": {
            "page": page,
            "pages": pages.max(page),
            "size": response_size,
            "total": total,
        }
    }))
}

async fn fetch_html(path: &str) -> Result<String, String> {
    let base = crate::net::base();
    tokio::time::timeout(REQUEST_TIMEOUT, async {
        let referer = format!("{base}/");
        let url = format!("{base}{path}");
        let mut response = crate::net::get(
            &url,
            REQUEST_TIMEOUT,
            Some("text/html,application/xhtml+xml"),
            Some(&referer),
        )
        .await?;

        if !response.status().is_success() {
            return Err(format!("官网频道页请求失败（HTTP {}）", response.status()));
        }
        if response
            .content_length()
            .is_some_and(|length| length > MAX_HTML_BYTES as u64)
        {
            return Err("官网频道页超过 2 MiB 限制".into());
        }

        let mut html = Vec::with_capacity(response.content_length().unwrap_or(0) as usize);
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|error| crate::net::err_text(&error))?
        {
            if html.len().saturating_add(chunk.len()) > MAX_HTML_BYTES {
                return Err("官网频道页超过 2 MiB 限制".into());
            }
            html.extend_from_slice(&chunk);
        }
        String::from_utf8(html).map_err(|_| "官网频道页不是有效的 UTF-8 HTML".into())
    })
    .await
    .map_err(|_| "获取官网频道页超时（12 秒）".to_string())?
}

fn category_route(cate: &str, page: u32, sort: Option<&str>) -> Option<(String, &'static str)> {
    if !matches!(cate, "ai-duanju" | "ai-manju") {
        return None;
    }
    let page = page.max(1);
    let (sub, panel) = match sort.map(str::trim).filter(|s| !s.is_empty()) {
        None | Some("latest") => ("", "latest"),
        Some("hot_window") | Some("hot") => ("hot/", "hot"),
        Some("random") => ("random/", "random"),
        _ => return None,
    };
    let path = if page == 1 {
        format!("/{cate}/{sub}")
    } else {
        format!("/{cate}/{sub}{page}/")
    };
    Some((path, panel))
}

fn original_route(cate: &str, page: u32) -> Option<(String, &'static str)> {
    let page = page.max(1);
    let (prefix, panel) = match cate.trim() {
        "all" => ("/original/", "drama"),
        "ai-manju" => ("/original/manju/", "comic"),
        "ai-duanju" => ("/original/duanju/", "short"),
        _ => return None,
    };
    let path = if page == 1 {
        prefix.to_string()
    } else {
        format!("{prefix}{page}/")
    };
    Some((path, panel))
}

pub async fn fetch_category(
    cate: &str,
    page: u32,
    size: u32,
    sort: Option<&str>,
) -> Result<Value, String> {
    let page = page.max(1);
    let (path, panel) = category_route(cate, page, sort)
        .ok_or_else(|| format!("不支持的官网频道映射：{cate}"))?;
    let html = fetch_html(&path).await?;
    parse_channel_html(&html, panel, page, size)
}

pub async fn fetch_original(cate: &str, page: u32, size: u32) -> Result<Value, String> {
    let page = page.max(1);
    let (path, panel) =
        original_route(cate, page).ok_or_else(|| format!("不支持的原创频道映射：{cate}"))?;
    let html = fetch_html(&path).await?;
    parse_channel_html(&html, panel, page, size)
}
