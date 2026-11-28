import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../shared/api/api";
import { exitApp } from "../shared/lib/appLifecycle";
import { IHome, IGrid, ISearch, IStar, ISettings, Logo } from "../shared/ui/icons";
import { useContentPreferences } from "../shared/model/contentPreferences";
import { contentKey, type TvContent } from "./model";
import { useTv } from "./TvProvider";
import { rememberFocus, restoreFocus, useRemoteScope } from "./remote";
import { indexMetadata, setCatalogPaused } from "./search/catalog";
import { saveContent } from "./library";
import { setPlaybackPreferences, usePlaybackPreferences } from "./preferences";
import { bootCheckTvUpdate, useTvHasUpdate } from "./updater";
import HomePage from "./HomePage";
import BrowsePage from "./BrowsePage";
import SearchPage from "./SearchPage";
import LibraryPage from "./LibraryPage";
import SettingsPage from "./SettingsPage";
import DetailPage from "./DetailPage";
import PlayerPage from "./PlayerPage";
import TvLanPushPanel from "./TvLanPushPanel";
import { TvModal, TvStatus } from "./ui";
import { usePendingDeepLink } from "../shared/lib/deepLink";
import {
  buildDemoOfflinePackageJson,
  DEMO_OFFLINE_SOURCE_ID,
  hasPlaybackCapability,
  isDemoOfflineSource,
} from "../shared/lib/demoSource";
type Tab = "home"|"browse"|"search"|"library"|"settings";
type Route = {kind:"detail";content:TvContent}|{kind:"player";content:TvContent;part:string;seconds:number};
const nav = [{id:"home",label:"首页",Icon:IHome},{id:"browse",label:"浏览",Icon:IGrid},{id:"search",label:"搜索",Icon:ISearch},{id:"library",label:"片库",Icon:IStar},{id:"settings",label:"设置",Icon:ISettings}] as const;
export default function TvApp(){
  const tv=useTv(),prefs=useContentPreferences(),playback=usePlaybackPreferences(),hasUpdate=useTvHasUpdate();
  const [tab,setTab]=useState<Tab>("home"),[visited,setVisited]=useState<Tab[]>(["home"]),[stack,setStack]=useState<Route[]>([]);
  const [deepLink,clearDeepLink]=usePendingDeepLink();
  const [deepBusy,setDeepBusy]=useState(false);
  const [deepErr,setDeepErr]=useState("");
  const [demoBusy,setDemoBusy]=useState(false);
  const [demoErr,setDemoErr]=useState("");
  const { sourceState, activeSource, refreshSourceState } = tv;
  const needsSource=sourceState!==null&&sourceState!=="unsupported"&&!activeSource;
  const demoActive=!needsSource&&isDemoOfflineSource(activeSource);
  const allowPlayback=!activeSource||hasPlaybackCapability(activeSource.capabilities);
  const enabledNav=useMemo(()=>nav.filter(({id})=>{
    if(!activeSource)return true;
    const c=activeSource.capabilities;
    if(id==="home")return c.home;
    if(id==="browse")return Boolean(c.catalog.categories||c.catalog.rankings||c.catalog.tags||c.posts||activeSource.catalog?.channels?.some((ch)=>(ch.kind==="post"?c.posts:c.catalog.categories)));
    if(id==="search")return c.search;
    return true;
  }),[activeSource]);
  const defaultTab=enabledNav[0]?.id??"library";
  const prevSourceId=useRef<string|null>(null);
  useEffect(()=>{
    const nextId=activeSource?.id??null;
    if((prevSourceId.current!==null&&prevSourceId.current!==nextId)||needsSource){
      setStack([]);
    }
    prevSourceId.current=nextId;
  },[activeSource?.id,needsSource]);
  useEffect(()=>{
    if(!enabledNav.some(item=>item.id===tab)){
      setTab(defaultTab);
      setVisited(v=>v.includes(defaultTab)?v:[...v,defaultTab]);
    }
  },[enabledNav,tab,defaultTab]);
  const current=stack[stack.length-1],playing=current?.kind==="player";
  const page=current?`${current.kind}:${contentKey(current.content)}`:tab;
  useEffect(()=>{setCatalogPaused(playing);return()=>setCatalogPaused(false);},[playing]);
  useEffect(()=>{
    if(!tv.ready||sourceState===null)return;
    bootCheckTvUpdate();
    // Clear a restored WebView scroll so the first page opens on its heading.
    const reset=()=>document.querySelectorAll<HTMLElement>(".tv-page-scroll").forEach(element=>{element.scrollTop=0;element.scrollLeft=0;});
    reset();const frame=requestAnimationFrame(reset);return()=>cancelAnimationFrame(frame);
  },[tv.ready,sourceState]);
  useEffect(()=>{restoreFocus(page);},[page,tv.ready]);
  const back=()=>{
    rememberFocus(page);
    if(stack.length){setStack(s=>s.slice(0,-1));return;}
    if(tab!==defaultTab){setTab(defaultTab);return;}
    void exitApp().catch(() => {});
  };
  useRemoteScope({id:"app",priority:0,onKey:key=>{if(key==="back"){back();return true;}}});
  const open=(content:TvContent)=>{rememberFocus(page);setStack(s=>[...s,{kind:"detail",content}]);};
  const navigate=(next:Tab)=>{rememberFocus(page);setTab(next);setVisited(v=>v.includes(next)?v:[...v,next]);setStack([]);};
  const metadata=(content:TvContent)=>{void indexMetadata(tv.source,[content]).catch(()=>{});void saveContent(content).catch(()=>{});};
  const entry=current?tv.library.find(item=>item.key===contentKey(current.content)):undefined;
  const tryDemoOffline=async()=>{
    if(demoBusy)return;
    setDemoBusy(true);setDemoErr("");
    try{
      await api.sourceImport(buildDemoOfflinePackageJson(),true);
      window.dispatchEvent(new Event("hg:line-changed"));
      window.dispatchEvent(new Event("hg:source-changed"));
      refreshSourceState();
    }catch(e){
      setDemoErr(e instanceof Error?e.message:String(e));
    }finally{
      setDemoBusy(false);
    }
  };
  const removeDemoOffline=async()=>{
    if(demoBusy)return;
    setDemoBusy(true);
    try{
      await api.sourceRemove(DEMO_OFFLINE_SOURCE_ID);
      window.dispatchEvent(new Event("hg:line-changed"));
      window.dispatchEvent(new Event("hg:source-changed"));
      refreshSourceState();
    }finally{
      setDemoBusy(false);
    }
  };
  if(!tv.ready||sourceState===null)return <main className="tv-boot-status"><h1>正在准备本地片库</h1><TvStatus busy={!tv.error} error={tv.error} onRetry={tv.retry}/></main>;
  return <div className="tv-app">
    {!playing&&<nav className="tv-sidebar" aria-label="主导航" data-tv-region="navigation" data-tv-columns="1"><div className="tv-brand"><Logo size={32}/><span>HGhubX <small>TV</small></span></div>{enabledNav.map(({id,label,Icon})=><button key={id} data-tv-focus={`nav-${id}`} className={id==="settings"?"tv-nav-settings":""} aria-label={id==="settings"&&hasUpdate?`${label}（有新版本）`:label} aria-current={!current&&tab===id?"page":undefined} onClick={()=>navigate(id)}><Icon size={26}/><span>{label}</span>{id==="settings"&&hasUpdate&&<em className="tv-update-dot" aria-hidden="true"/>}</button>)}</nav>}
    <main className={`tv-main-area${demoActive&&!current?" is-demo-active":""}`} hidden={!!current}>
      {demoActive&&!current&&tab!=="settings"&&(
        <div className="tv-demo-banner" role="status" data-tv-region="demo-banner" data-tv-columns="1">
          <span>离线示例源</span>
          <button data-tv-focus="demo-remove" disabled={demoBusy} onClick={()=>void removeDemoOffline()}>
            {demoBusy?"移除中…":"移除示例源"}
          </button>
        </div>
      )}
      {needsSource&&tab!=="settings"?(
        <div className="tv-page-scroll tv-source-empty" data-tv-scroll-id="page-source-empty">
          <div className="tv-connect-hero">
            <h1 className="tv-connect-hero-head">导入视频源</h1>
            <TvLanPushPanel onImported={refreshSourceState} />
            <div className="tv-demo-entry" data-tv-region="source-demo" data-tv-columns="1">
              <div className="tv-demo-entry-copy">
                <strong>试用离线示例源</strong>
              </div>
              <button data-tv-focus="source-try-demo" disabled={demoBusy} onClick={()=>void tryDemoOffline()}>
                {demoBusy?"载入中…":"试用离线示例源"}
              </button>
            </div>
            {demoErr&&<p role="alert" className="tv-lan-error">{demoErr}</p>}
          </div>
        </div>
      ):visited.filter(name=>enabledNav.some(item=>item.id===name)).map(name=><div key={name} hidden={tab!==name} className="tv-page-scroll" data-tv-scroll-id={`page-${name}`}>
        {name==="home"&&<HomePage active={tab==="home"&&!current} onOpen={open}/>}{name==="browse"&&<BrowsePage active={tab==="browse"&&!current} onOpen={open}/>}{name==="search"&&<SearchPage key={tv.sourceKey} source={tv.source} paused={playing||tab!=="search"||!!current} allowVideos={!activeSource||activeSource.capabilities.home} allowPosts={!activeSource||activeSource.capabilities.posts} onOpen={open}/>}{name==="library"&&<LibraryPage active={tab==="library"&&!current} onOpen={open}/>}{name==="settings"&&<SettingsPage/>}
      </div>)}
    </main>
    {current?.kind==="detail"&&<div className="tv-detail-route" data-tv-scroll-id={page}><DetailPage key={contentKey(current.content)} content={current.content} sourceKey={tv.sourceKey} progress={entry?.progress} favorite={!!entry?.favorite} onFavorite={tv.toggleFavorite} onBack={back} onMetadata={metadata} onPlay={(content,part,seconds=0)=>{if(!allowPlayback)return;rememberFocus(page);setStack(s=>[...s,{kind:"player",content,part,seconds}]);}}/></div>}
    {current?.kind==="player"&&<PlayerPage key={contentKey(current.content)} content={current.content} sourceKey={tv.sourceKey} part={current.part} resumeSeconds={current.seconds} favorite={!!entry?.favorite} rate={playback.rate} quality={playback.quality} autoNext={playback.autoplayNext} skipIntroSecs={playback.skipIntroSecs} skipOutroSecs={playback.skipOutroSecs} onPreferencesChange={setPlaybackPreferences} onFavorite={tv.toggleFavorite} onProgress={tv.progress} onMetadata={metadata} onBack={back}/>}
    {(tv.error||prefs.storageError)&&<div className="tv-notice" role="alert">{tv.error||prefs.storageError}</div>}
    {tv.syncNotice&&<div className="tv-sync-toast" role="status">{tv.syncNotice}</div>}
    {deepLink&&<TvModal id="tv-deep-link" title="导入视频源" onClose={()=>{if(!deepBusy){setDeepErr("");clearDeepLink();}}}>
      <code style={{display:"block",wordBreak:"break-all",marginBottom:14,opacity:.85}}>{deepLink}</code>
      {deepErr&&<p role="alert" style={{color:"#f87171",marginBottom:10}}>{deepErr}</p>}
      <div className="tv-options">
        <button data-tv-focus="dl-cancel" disabled={deepBusy} onClick={()=>{setDeepErr("");clearDeepLink();}}>取消</button>
        <button data-tv-focus="dl-go" disabled={deepBusy} onClick={()=>{setDeepBusy(true);setDeepErr("");void api.sourceImport(deepLink,true).then(()=>{window.dispatchEvent(new Event("hg:line-changed"));window.dispatchEvent(new Event("hg:source-changed"));clearDeepLink();}).catch(e=>setDeepErr(String(e))).finally(()=>setDeepBusy(false));}}>{deepBusy?"导入中…":"导入"}</button>
      </div>
    </TvModal>}
  </div>;
}
