use dom_query::{Document, Selection};
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::HashSet;
use std::time::Duration;

const MAX_HTML_BYTES: usize = 2 * 1024 * 1024;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(12);
const MAX_ITEMS: usize = 20;
const MAX_HOT_TAGS: usize = 50;
const JS_MAX_SAFE_INTEGER: i64 = 9_007_199_254_740_991;

#[derive(Debug, Serialize, PartialEq, Eq)]
struct HotVideo {
    video_id: i64,
    title: String,
    plays: String,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
struct HotTag {
    name: String,
    slug: String,
}

fn normalized_text(selection: Selection<'_>) -> String {
    normalized_string(&selection.text())
}

fn normalized_string(value: &str) -> String {
    value.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn video_id_from_href(href: &str) -> Option<i64> {
    let id = href.strip_prefix("/video/")?.strip_suffix('/')?;
    if id.is_empty() || !id.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    let id = id.parse::<i64>().ok()?;
    (id > 0 && id <= JS_MAX_SAFE_INTEGER).then_some(id)
}

fn parse_items(html: &str) -> Result<Vec<HotVideo>, String> {
    let document = Document::from(html);
    let sections = document.select("section.hg-search-hot");
    if sections.is_empty() {
        return Err("官网搜索页没有找到热搜榜区域".into());
    }

    let mut seen = HashSet::new();
    let mut items = Vec::new();
    for section in sections.iter() {
        for anchor in Selection::from(section).select("a.hg-search-hot__item").iter() {
            let Some(video_id) = anchor
                .attr("href")
                .and_then(|href| video_id_from_href(&href))
            else {
                continue;
            };
            if seen.contains(&video_id) {
                continue;
            }

            let anchor = Selection::from(anchor);
            let title = normalized_text(anchor.select(".hg-search-hot__name"));
            let title = if title.is_empty() {
                anchor
                    .attr("data-search-hot")
                    .map(|title| normalized_string(&title))
                    .unwrap_or_default()
            } else {
                title
            };
            let plays = normalized_text(anchor.select(".hg-search-hot__plays"));
            if title.is_empty() || plays.is_empty() {
                continue;
            }

            seen.insert(video_id);
            items.push(HotVideo {
                video_id,
                title,
                plays,
            });
            if items.len() == MAX_ITEMS {
                return Ok(items);
            }
        }
    }

    if items.is_empty() {
        Err("官网热搜榜没有可用条目".into())
    } else {
        Ok(items)
    }
}

fn tag_slug_from_href(href: &str) -> Option<String> {
    let rest = href.strip_prefix("/tag/")?;
    let slug = rest.strip_suffix('/').unwrap_or(rest);
    if slug.is_empty()
        || slug == "."
        || slug == ".."
        || slug
            .chars()
            .any(|ch| ch.is_whitespace() || matches!(ch, '/' | '?' | '#' | '\\'))
    {
        return None;
    }
    Some(slug.to_owned())
}

fn parse_hot_tags(html: &str) -> Result<Vec<HotTag>, String> {
    let document = Document::from(html);
    let sections = document.select("section.hg-home-popular-tags");
    if sections.is_empty() {
        return Err("官网首页没有找到热门标签区域".into());
    }

    let mut seen = HashSet::new();
    let mut items = Vec::new();
    for section in sections.iter() {
        for anchor in Selection::from(section).select("a.hg-tagrow__item").iter() {
            let Some(slug) = anchor
                .attr("href")
                .and_then(|href| tag_slug_from_href(&href))
            else {
                continue;
            };
            let name = normalized_text(Selection::from(anchor));
            if name.is_empty() || seen.contains(&name) {
                continue;
            }
            seen.insert(name.clone());
            items.push(HotTag { name, slug });
            if items.len() == MAX_HOT_TAGS {
                return Ok(items);
            }
        }
    }

    if items.is_empty() {
        Err("官网热门标签没有可用条目".into())
    } else {
        Ok(items)
    }
}

fn search_page_url(base: &str) -> String {
    format!("{}/search/", base.trim_end_matches('/'))
}

fn home_page_url(base: &str) -> String {
    format!("{}/", base.trim_end_matches('/'))
}

async fn fetch_html(url: &str, page_label: &str, timeout_msg: &str) -> Result<String, String> {
    let base = crate::net::base();
    tokio::time::timeout(REQUEST_TIMEOUT, async {
        let referer = format!("{base}/");
        let mut response = crate::net::get(
            url,
            REQUEST_TIMEOUT,
            Some("text/html,application/xhtml+xml"),
            Some(&referer),
        )
        .await?;

        if !response.status().is_success() {
            return Err(format!("{page_label}请求失败（HTTP {}）", response.status()));
        }
        if response
            .content_length()
            .is_some_and(|length| length > MAX_HTML_BYTES as u64)
        {
            return Err(format!("{page_label}超过 2 MiB 限制"));
        }

        let mut html = Vec::with_capacity(response.content_length().unwrap_or(0) as usize);
        while let Some(chunk) = response.chunk().await.map_err(|error| crate::net::err_text(&error))? {
            if html.len().saturating_add(chunk.len()) > MAX_HTML_BYTES {
                return Err(format!("{page_label}超过 2 MiB 限制"));
            }
            html.extend_from_slice(&chunk);
        }
        String::from_utf8(html).map_err(|_| format!("{page_label}不是有效的 UTF-8 HTML"))
    })
    .await
    .map_err(|_| timeout_msg.to_string())?
}

pub async fn fetch() -> Result<Value, String> {
    let url = search_page_url(&crate::net::base());
    let html = fetch_html(&url, "官网搜索页", "获取官网热搜超时（12 秒）")
        .await
        .map_err(|error| format!("获取官网热搜失败：{error}"))?;
    let items =
        parse_items(&html).map_err(|error| format!("获取官网热搜失败：{error}"))?;
    Ok(json!({ "items": items }))
}

pub async fn fetch_hot_tags() -> Result<Value, String> {
    let url = home_page_url(&crate::net::base());
    let html = fetch_html(&url, "官网首页", "获取官网热门标签超时（12 秒）")
        .await
        .map_err(|error| format!("获取官网热门标签失败：{error}"))?;
    let items =
        parse_hot_tags(&html).map_err(|error| format!("获取官网热门标签失败：{error}"))?;
    Ok(json!({ "items": items }))
}

#[cfg(test)]
mod tests {
    use super::{
        parse_hot_tags, parse_items, tag_slug_from_href, video_id_from_href, JS_MAX_SAFE_INTEGER,
    };

    #[test]
    fn parses_hot_section_in_dom_order_and_decodes_entities() {
        let html = r#"
            <section class="hg-search-hot">
              <a class="hg-search-hot__item" href="/video/3483/" data-search-hot="fallback">
                <span class="hg-search-hot__name">琼明&nbsp;神女录 &amp; 特别篇</span>
                <span class="hg-search-hot__plays"><img alt="play">1185.1w播放量</span>
              </a>
              <a class="hg-search-hot__item" href="/video/11571/">
                <span class="hg-search-hot__name">第二部</span>
                <span class="hg-search-hot__plays">267.3w播放量</span>
              </a>
            </section>
        "#;

        let items = parse_items(html).unwrap();
        assert_eq!(items[0].video_id, 3483);
        assert_eq!(items[0].title, "琼明 神女录 & 特别篇");
        assert_eq!(items[0].plays, "1185.1w播放量");
        assert_eq!(items[1].video_id, 11571);
    }

    #[test]
    fn falls_back_to_data_title_and_deduplicates_by_video_id() {
        let html = r#"
            <section class="hg-search-hot">
              <a class="hg-search-hot__item" href="/video/7/" data-search-hot="首条 &amp; 实体">
                <span class="hg-search-hot__plays">1.2亿播放量</span>
              </a>
              <a class="hg-search-hot__item" href="/video/7/" data-search-hot="重复条目">
                <span class="hg-search-hot__plays">999播放量</span>
              </a>
            </section>
        "#;

        let items = parse_items(html).unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].title, "首条 & 实体");
        assert_eq!(items[0].plays, "1.2亿播放量");
    }

    #[test]
    fn rejects_external_malformed_and_unsafe_ids() {
        assert_eq!(video_id_from_href("https://huangguoai.com/video/1/"), None);
        assert_eq!(video_id_from_href("//huangguoai.com/video/1/"), None);
        assert_eq!(video_id_from_href("/video/0/"), None);
        assert_eq!(video_id_from_href("/video/1/extra/"), None);
        assert_eq!(video_id_from_href("/video/9007199254740992/"), None);
        assert_eq!(video_id_from_href("/video/9007199254740991/"), Some(JS_MAX_SAFE_INTEGER));
    }

    #[test]
    fn ignores_links_outside_hot_section_and_reports_missing_or_empty_sections() {
        let outside = r#"<a class="hg-search-hot__item" href="/video/1/">
            <span class="hg-search-hot__name">外部</span><span class="hg-search-hot__plays">2w</span>
        </a>"#;
        assert_eq!(parse_items(outside).unwrap_err(), "官网搜索页没有找到热搜榜区域");

        let invalid = r#"<section class="hg-search-hot">
            <a class="hg-search-hot__item" href="https://evil.example/video/1/" data-search-hot="外域">
              <span class="hg-search-hot__plays">2w</span>
            </a>
        </section>"#;
        assert_eq!(parse_items(invalid).unwrap_err(), "官网热搜榜没有可用条目");
        assert_eq!(
            parse_items("<section class=\"hg-search-hot\"></section>").unwrap_err(),
            "官网热搜榜没有可用条目"
        );
    }

    #[test]
    fn parses_hot_tags_in_dom_order_and_deduplicates() {
        let html = r#"
            <section class="hg-section hg-home-popular-tags">
              <div class="hg-tagrow__scroll" id="home-popular-tags-scroll">
                <a class="hg-tagrow__item" href="/tag/dushi/">都市</a>
                <a class="hg-tagrow__item" href="/tag/gufeng/">古风 &amp; 奇幻</a>
                <a class="hg-tagrow__item" href="/tag/dushi/">都市</a>
                <a class="hg-tagrow__item" href="/tag/ntr/">NTR</a>
              </div>
            </section>
        "#;

        let tags = parse_hot_tags(html).unwrap();
        assert_eq!(tags.len(), 3);
        assert_eq!(tags[0].name, "都市");
        assert_eq!(tags[0].slug, "dushi");
        assert_eq!(tags[1].name, "古风 & 奇幻");
        assert_eq!(tags[1].slug, "gufeng");
        assert_eq!(tags[2].name, "NTR");
        assert_eq!(tags[2].slug, "ntr");
    }

    #[test]
    fn rejects_external_or_malformed_tag_hrefs() {
        assert_eq!(tag_slug_from_href("https://huangguoai.com/tag/dushi/"), None);
        assert_eq!(tag_slug_from_href("//huangguoai.com/tag/dushi/"), None);
        assert_eq!(tag_slug_from_href("/tag/"), None);
        assert_eq!(tag_slug_from_href("/tag/../"), None);
        assert_eq!(tag_slug_from_href("/tag/a/b/"), None);
        assert_eq!(tag_slug_from_href("/tag/dushi?x=1"), None);
        assert_eq!(tag_slug_from_href("/tag/dushi/").as_deref(), Some("dushi"));
        assert_eq!(tag_slug_from_href("/tag/ai-duanju").as_deref(), Some("ai-duanju"));
    }

    #[test]
    fn ignores_tag_links_outside_popular_section_and_reports_missing_or_empty() {
        let outside = r#"<a class="hg-tagrow__item" href="/tag/dushi/">都市</a>"#;
        assert_eq!(parse_hot_tags(outside).unwrap_err(), "官网首页没有找到热门标签区域");

        let invalid = r#"<section class="hg-section hg-home-popular-tags">
            <a class="hg-tagrow__item" href="https://evil.example/tag/dushi/">外域</a>
            <a class="hg-tagrow__item" href="/tag/empty/">   </a>
        </section>"#;
        assert_eq!(parse_hot_tags(invalid).unwrap_err(), "官网热门标签没有可用条目");
        assert_eq!(
            parse_hot_tags("<section class=\"hg-home-popular-tags\"></section>").unwrap_err(),
            "官网热门标签没有可用条目"
        );
    }
}
