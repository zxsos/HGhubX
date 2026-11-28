import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../shared/api/api";
import type { TagGroup, TopicCard } from "../shared/api/types";
import { useContentPreferences } from "../shared/model/contentPreferences";
import { type TvContent, contentKey } from "./model";
import { videoCard, rankCard, postCard } from "./catalogCards";
import { qualifyVisiblePosts } from "./postEligibility";
import { indexMetadata } from "./search/catalog";
import { useTv } from "./TvProvider";
import { TvCard, TvStatus } from "./ui";
import { useRemoteScope } from "./remote";
type BrowseChannel = {
  id: string;
  label: string;
  mode: "category" | "feed" | "rank" | "topics" | "tags" | "posts";
  sort?: string;
};

export default function BrowsePage({ onOpen, active=true }: { onOpen: (content: TvContent) => void; active?: boolean }) {
  const { source, sourceKey, activeSource, sourceState } = useTv(), preferences = useContentPreferences();
  const channels = useMemo<BrowseChannel[]>(() => {
    const permissive = sourceState === "unsupported";
    const caps = activeSource?.capabilities;
    const list: BrowseChannel[] = [];
    const activeDeclared = activeSource?.catalog?.channels?.filter((ch) =>
      ch.kind === "post" ? (permissive || caps?.posts) : (permissive || caps?.catalog.categories),
    );
    if (activeDeclared?.length) {
      for (const ch of activeDeclared) {
        if (ch.kind === "post") {
          list.push({ id: ch.id, label: ch.label, mode: "posts", sort: ch.sorts?.[0] });
        } else {
          list.push({ id: ch.id, label: ch.label, mode: "category", sort: ch.sorts?.[0] });
        }
      }
    } else if (permissive || caps?.home) {
      list.push({ id: "__feed__", label: "推荐内容", mode: "feed" });
    }
    if (permissive || caps?.catalog.rankings) list.push({ id: "rank", label: "排行", mode: "rank" });
    if (permissive || (caps?.catalog.topics ?? caps?.catalog.categories)) list.push({ id: "topics", label: "专题", mode: "topics" });
    if (permissive || caps?.catalog.tags) list.push({ id: "tags", label: "标签", mode: "tags" });
    if ((permissive || caps?.posts) && !list.some(c => c.mode === "posts")) {
      list.push({ id: "posts", label: "帖子", mode: "posts" });
    }
    return list;
  }, [activeSource, sourceState]);
  const [channel,setChannel]=useState(()=>channels[0]?.id??""), [selection,setSelection]=useState(""), [items,setItems]=useState<TvContent[]>([]), [topics,setTopics]=useState<TopicCard[]>([]), [tags,setTags]=useState<TagGroup[]>([]);
  const [busy,setBusy]=useState(false),[error,setError]=useState(""),[retryable,setRetryable]=useState(0),[done,setDone]=useState(false);
  useEffect(()=>{
    if(!channels.some(c=>c.id===channel)){
      setChannel(channels[0]?.id??"");
      setSelection("");
    }
  },[channels,channel]);
  const activeChannel=channels.find(c=>c.id===channel)??null;
  const route=`${sourceKey}:${channel}:${selection}:${preferences.revision}`;
  const [request,setRequest]=useState({route:"",page:1,retry:0});
  const routeRef=useRef(route); routeRef.current=route;
  const activeRef=useRef(active); activeRef.current=active;
  const fulfilled=useRef<typeof request | null>(null);
  const seq=useRef(0), prefsRef=useRef(preferences); prefsRef.current=preferences;
  const seenPages=useRef(new Map<number,string>()), candidates=useRef<TvContent[]>([]), nextPage=useRef(2);
  useEffect(()=>{
    setItems([]);setTopics([]);setTags([]);setError("");setDone(false);setRetryable(0);
    seenPages.current.clear();candidates.current=[];nextPage.current=2;
    setRequest({route,page:1,retry:0});
  },[route]);
  useEffect(()=>{
    // A route change renders once with the previous request. Only its reset
    // request may start I/O, so changing channel on page 4 never fetches page 4.
    if(request.route!==route || !source || !active || !activeChannel){if(!activeChannel)setBusy(false);return;}
    if(fulfilled.current===request){setBusy(false);return;}
    const token=++seq.current; let disposed=false;
    const current=()=>!disposed && token===seq.current && routeRef.current===route && activeRef.current;
    setBusy(true);setError("");setRetryable(0);
    void (async()=>{
      try {
        const mode=activeChannel.mode;
        if(mode==="topics"&&!selection){const result=await api.topics();if(current()){setTopics(result.items);setDone(true);fulfilled.current=request;}return;}
        if(mode==="tags"&&!selection){
          let categories: TagGroup[] = [];
          try {
            categories = (await api.tags()).categories;
          } catch (tagErr) {
            const msg = tagErr instanceof Error ? tagErr.message : String(tagErr ?? "");
            if (/未实现|unimplemented|not implemented/i.test(msg)) {
              const hot = await api.hotTags();
              categories = hot.items.length
                ? [{ name: "热门标签", tags: hot.items.map((item, idx) => ({ id: idx + 1, name: item.name, slug: item.slug })) }]
                : [];
            } else throw tagErr;
          }
          if(current()){setTags(categories);setDone(true);fulfilled.current=request;}
          return;
        }
        if(mode==="rank"){const result=await api.rank("hot");if(current()){const next=result.items.map(rankCard);setItems(next);setDone(true);fulfilled.current=request;void indexMetadata(source,next).catch(()=>{});}return;}
        let page=request.page, added:TvContent[]=[], pending:TvContent[]=[], retryCount=0, finished=false;
        const pages=new Map(seenPages.current);
        for(let extra=0;extra<3;extra++){
          let response;
          if(mode==="posts"){
            response=activeChannel.id!=="posts"
              ?await api.postCategory(activeChannel.id,page,20,activeChannel.sort)
              :await api.posts(page,20,activeChannel.sort);
          }else if(mode==="feed"){
            response=await api.feed(page,20);
          }else if(mode==="topics"){
            response=(await api.topic(selection,page,20)).videos;
          }else if(mode==="tags"){
            try{response=await api.tagVideos(selection,page,20);}
            catch(tagErr){
              const msg=tagErr instanceof Error?tagErr.message:String(tagErr??"");
              if(/未实现|unimplemented|not implemented/i.test(msg))response=await api.search(selection,page,20,"video");
              else throw tagErr;
            }
          }else{
            response=await api.category(activeChannel.id,page,20,activeChannel.sort);
          }
          if(!current())return;
          const paging=response.pagination;
          if(!paging || !Number.isSafeInteger(paging.page) || paging.page!==page || !Number.isSafeInteger(paging.pages) || paging.pages<0)throw new Error("目录分页未推进，请重试");
          const meta=mode==="posts"?(response.items as Parameters<typeof postCard>[0][]).map(postCard):(response.items as Parameters<typeof videoCard>[0][]).map(videoCard);
          const signature=meta.map(contentKey).sort().join(",");
          if(meta.length && [...pages].some(([previous,value])=>previous!==page&&value===signature))throw new Error("目录返回重复页，请重试");
          if(!meta.length && page<paging.pages)throw new Error("目录返回空页，请重试");
          if(paging.pages<page && !(page===1&&!meta.length&&paging.pages===0))throw new Error("目录分页发生变化，请重试");
          pages.set(page,signature); void indexMetadata(source,meta).catch(()=>{});
          let allowed=meta.filter(content=>!prefsRef.current.blockReason(content.tags));
          if(mode==="posts"){
            pending.push(...allowed);
            const result=await qualifyVisiblePosts(allowed,{source,isCurrent:current,allowed:content=>!prefsRef.current.blockReason(content.tags)},request.retry>0);
            if(!current())return; allowed=result.items;retryCount+=result.retryable;
          }
          added.push(...allowed); finished=page>=paging.pages;
          if(mode!=="posts"||added.length||finished||extra===2)break;
          page++;
        }
        if(current()){
          setItems(previous=>{const map=new Map((request.page===1?[]:previous).map(item=>[contentKey(item),item]));for(const item of added)map.set(contentKey(item),item);return [...map.values()];});
          setDone(finished);
          if(mode==="posts"){
            const addedKeys=new Set(added.map(contentKey));
            const mergedCandidates=[...new Map([...(request.page===1?[]:candidates.current),...pending].filter(c=>!addedKeys.has(contentKey(c))).map(c=>[contentKey(c),c])).values()];
            candidates.current=mergedCandidates;
            setRetryable(prev=>request.page===1?retryCount:prev+retryCount);
          }else{
            candidates.current=[];
            setRetryable(0);
          }
          seenPages.current=pages;nextPage.current=page+1;fulfilled.current=request;
        }
      }catch(e){if(current())setError(String(e));}finally{if(current())setBusy(false);}
    })(); return()=>{disposed=true;seq.current++;};
  },[request,route,source,activeChannel,selection,active]);
  useRemoteScope({ id: "browse-subpage", priority: 10, onKey: key => { if (active && selection && key === "back") { setSelection(""); return true; } } });
  const retry=async()=>{
    if(busy)return;
    if(activeChannel?.mode==="posts"&&retryable&&candidates.current.length){
      const token=++seq.current, key=route;setBusy(true);setError("");
      const current=()=>token===seq.current&&routeRef.current===key&&activeRef.current;
      try{const result=await qualifyVisiblePosts(candidates.current,{source,isCurrent:current,allowed:c=>!prefsRef.current.blockReason(c.tags)},true);
        if(current()){
          const resolvedKeys=new Set(result.items.map(contentKey));
          candidates.current=candidates.current.filter(c=>!resolvedKeys.has(contentKey(c)));
          setItems(prev=>[...new Map([...prev,...result.items].map(c=>[contentKey(c),c])).values()]);
          setRetryable(result.retryable);
        }}
      catch(e){if(current())setError(String(e));}
      finally{if(current())setBusy(false);}return;
    }
    setRequest(r=>({...r,retry:r.retry+1}));
  };
  const isPostChannel = activeChannel?.mode === "posts";
  return <><header className="tv-page-heading"><h1>浏览</h1></header>
    <div className="tv-tabs-rail" data-tv-region="browse-channels">{channels.map(c=><button key={c.id} data-tv-focus={`channel-${c.id}`} aria-pressed={channel===c.id} onClick={()=>{setChannel(c.id);setSelection("");}}>{c.label}</button>)}</div>
    {selection&&<button data-tv-focus="browse-up" onClick={()=>setSelection("")}>返回{activeChannel?.mode==="tags"?"标签":"专题"}</button>}
    <TvStatus busy={busy} error={error} onRetry={()=>void retry()}/>
    {topics.length>0&&<div className="tv-grid" data-tv-region="topics" data-tv-columns="5">{topics.map(topic=><button className="tv-collection" data-tv-focus={`topic-${topic.slug}`} key={topic.slug} onClick={()=>setSelection(topic.slug)}><strong>{topic.title}</strong><small>{topic.video_count||0} 部</small></button>)}</div>}
    {tags.map(group=><section key={group.name}><h2>{group.name}</h2><div className="tv-tags" data-tv-region={`tags-${group.name}`} data-tv-columns="5">{group.tags.filter(tag=>!preferences.isTagBlocked(tag.name)).map(tag=><button data-tv-focus={`tag-${tag.id}`} key={tag.id} onClick={()=>setSelection(tag.name)}>{tag.name}</button>)}</div></section>)}
    <div className={`tv-grid ${isPostChannel?"tv-grid-wide":""}`} data-tv-region="browse-grid" data-tv-columns={isPostChannel?3:5}>{items.filter(c=>!preferences.blockReason(c.tags)).map(content=><TvCard key={contentKey(content)} content={content} onOpen={onOpen}/>)}</div>
    {!busy&&retryable>0&&<p role="status">{retryable} 个候选暂未确认可播放。<button data-tv-focus="post-retry" onClick={()=>void retry()}>重试确认</button></p>}
    {!busy&&!done&&!error&&source&&activeChannel&&<button data-tv-focus="browse-more" onClick={()=>setRequest(r=>({route,page:nextPage.current,retry:r.retry}))}>继续加载</button>}
    {!busy&&!error&&!items.length&&!topics.length&&!tags.length&&<p className="tv-status">{channels.length?(done?"当前页暂无可展示内容":"当前页暂无可展示内容，可继续加载"):"当前视频源暂无可浏览频道"}</p>}
  </>;
}
