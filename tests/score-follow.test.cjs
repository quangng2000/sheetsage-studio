"use strict";

// Controller contracts only: a small DOM/SVG stand-in is not a layout engine.
// Actual engraving geometry and scrolling are also verified in the native app.
const test = require("node:test");
const assert = require("node:assert/strict");
const {create} = require("../desktop/ui/score-follow.js");

class Element {
  constructor(tag, ownerDocument, rect = {left:0,top:0,width:10,height:10}) {
    this.tagName=tag;this.ownerDocument=ownerDocument;this.rect=rect;this.className="";
    this.parentElement=null;this.children=[];this.attributes={};this.listeners=new Map();
    this.style={};this.hidden=false;this.disabled=false;this.textContent="";
    this.scrollTop=0;this.scrollLeft=0;this.scrollCalls=[];
    this.classList={
      contains:(name)=>this.className.split(/\s+/).includes(name),
      add:(...names)=>{this.className=[...new Set([...this.className.split(/\s+/).filter(Boolean),...names])].join(" ");},
      remove:(...names)=>{this.className=this.className.split(/\s+/).filter((name)=>!names.includes(name)).join(" ");},
    };
  }
  setAttribute(name,value){this.attributes[name]=String(value);}
  getAttribute(name){return this.attributes[name]??null;}
  removeAttribute(name){delete this.attributes[name];}
  querySelectorAll(selector){
    const matches=[];
    const visit=(element)=>{for(const child of element.children){if(child.tagName.toLowerCase()===selector.toLowerCase())matches.push(child);visit(child);}};
    visit(this);return matches;
  }
  append(...elements){elements.forEach((element)=>{element.remove();element.parentElement=this;this.children.push(element);});}
  appendChild(element){this.append(element);return element;}
  remove(){if(this.parentElement){const siblings=this.parentElement.children;const index=siblings.indexOf(this);if(index>=0)siblings.splice(index,1);this.parentElement=null;}}
  addEventListener(name,listener){if(!this.listeners.has(name))this.listeners.set(name,[]);this.listeners.get(name).push(listener);}
  dispatch(type,values={}){const event={type,target:this,currentTarget:this,defaultPrevented:false,preventDefault(){this.defaultPrevented=true;},...values};for(const listener of this.listeners.get(type)||[])listener(event);return event;}
  getBoundingClientRect(){const {left,top,width,height}=this.rect;return{left,top,width,height,right:left+width,bottom:top+height};}
  scrollTo(options){this.scrollCalls.push(options);if(Number.isFinite(options.top))this.scrollTop=options.top;}
}

function harness() {
  const document={createElement:(tag)=>new Element(tag,document)};
  const root=new Element("div",document,{left:50,top:100,width:700,height:200});
  const button=new Element("button",document),status=new Element("span",document),seeks=[];
  const follow=create({root,button,status,onSeek:(time)=>seeks.push(time)});
  function glyph(duration,{rest=false,x=80,y=140,char=0,pitch=60}={}){
    const element=new Element("g",document,{left:x,top:y,width:12,height:18});
    const child=new Element("path",document,{left:x+1,top:y+1,width:10,height:16});element.append(child);root.append(element);
    return{element,child,absolute:{type:rest?"rest":"note",duration,durationClass:duration,elemset:[element],x,w:12,
      abcelem:{el_type:"note",duration,startChar:char,endChar:char+2,...(rest?{rest:{type:"rest"}}:{pitches:[{pitch}]})}}};
  }
  function group(voices,line=0){const staffs=voices.map(()=>({}));return{line,staffs,voices:voices.map((children,index)=>({staff:staffs[index],voicenumber:0,children:children.map((item)=>item.absolute??item)}))};}
  const tune=(...groups)=>({engraver:{staffgroups:groups}});
  const cursor=()=>root.children.find((element)=>element.className==="score-audio-cursor");
  return{document,root,button,status,seeks,follow,glyph,group,tune,cursor};
}

function mappedResult({exact=true}={}) {
  return{summary:{duration_seconds:8},playback:{duration:8,measures:[
    {index:0,start:0,end:4,score_start:0,score_end:1},
    {index:1,start:4,end:8,score_start:1,score_end:2},
  ]},...(exact?{score_timing:{version:1,notation_beats:Array.from({length:9},(_,i)=>`${i} ${i%4+1} 4 4`).join("\n")}}:{})};
}

test("unmapped score leaves notation readable and follow unavailable",()=>{
  const h=harness(),note=h.glyph(.25);h.follow.attach({},h.tune(h.group([[note]])));
  assert.equal(h.button.disabled,true);assert.ok(h.status.textContent.includes("No score-to-audio measure map"));
  assert.equal(note.element.classList.contains("score-seekable"),false);assert.equal(h.cursor(),undefined);
});

test("rendered SVG containers expose interactive glyph buttons instead of remaining atomic images",()=>{
  const h=harness(),a=h.glyph(.25),b=h.glyph(.25,{x:140});
  const svg=new Element("svg",h.document);svg.setAttribute("role","img");svg.setAttribute("aria-label","Sheet music");
  const wrapper=new Element("g",h.document);wrapper.append(a.element,b.element);svg.append(wrapper);h.root.append(svg);
  h.follow.attach(mappedResult(),h.tune(h.group([[a,b]])));
  assert.equal(svg.getAttribute("role"),"group");assert.equal(svg.getAttribute("aria-label"),"Interactive sheet music");
  assert.equal(a.element.getAttribute("role"),"button");assert.equal(b.element.getAttribute("role"),"button");
  assert.equal(a.element.parentElement,wrapper);assert.equal(b.element.parentElement,wrapper);
  h.root.dispatch("click",{target:b.child});assert.equal(h.seeks.at(-1),1);
});

test("simultaneous sustained voices highlight independently and rests receive a distinct style",()=>{
  const h=harness();
  const sustained=h.glyph(.75),next=h.glyph(.25,{x:170});
  const a=h.glyph(.25),b=h.glyph(.25,{x:120}),rest=h.glyph(.25,{rest:true,x:150}),c=h.glyph(.25,{x:180});
  h.follow.attach(mappedResult(),h.tune(h.group([[sustained,next],[a,b,rest,c]])));
  h.follow.setPlayback(1.5,true,true);
  assert.equal(sustained.element.classList.contains("score-note-active"),true);
  assert.equal(b.element.classList.contains("score-note-active"),true);
  assert.equal(a.element.classList.contains("score-note-active"),false);
  h.follow.setPlayback(2.5,true,true);
  assert.equal(sustained.element.classList.contains("score-note-active"),true);
  assert.equal(b.element.classList.contains("score-note-active"),false);
  assert.equal(rest.element.classList.contains("score-rest-active"),true);
  assert.equal(rest.element.classList.contains("score-note-active"),false);
  h.follow.setPlayback(3.5,false,true);
  assert.equal(sustained.element.classList.contains("score-note-active"),false);
  assert.equal(rest.element.classList.contains("score-rest-active"),false);
  assert.equal(next.element.classList.contains("score-note-active"),true);
});

test("nested SVG clicks and Enter/Space seek with ScoreTiming, while other keys do nothing",()=>{
  const h=harness(),a=h.glyph(.25),b=h.glyph(.25,{rest:true,char:3});
  h.follow.attach(mappedResult(),h.tune(h.group([[a,b]])));
  const click=h.root.dispatch("click",{target:b.child});
  assert.equal(click.defaultPrevented,true);assert.equal(h.seeks.at(-1),1);
  assert.equal(b.element.getAttribute("role"),"button");assert.equal(b.element.getAttribute("tabindex"),"0");
  assert.ok(b.element.getAttribute("aria-label").includes("0:01.00 · rest"));
  for(const key of["Enter"," "]){const event=h.root.dispatch("keydown",{target:b.child,key});assert.equal(event.defaultPrevented,true);assert.equal(h.seeks.at(-1),1);}
  const count=h.seeks.length;h.root.dispatch("keydown",{target:b.child,key:"ArrowRight"});assert.equal(h.seeks.length,count);
});

test("printed score tempo does not replace the recording clock",()=>{
  const h=harness(),a=h.glyph(.25),b=h.glyph(.25);
  const score=h.tune(h.group([[a,b]]));score.metaText={tempo:{bpm:999,duration:[.375]}};
  h.follow.attach(mappedResult(),score);h.follow.setPlayback(1.25,true,true);
  assert.equal(a.element.classList.contains("score-note-active"),false);assert.equal(b.element.classList.contains("score-note-active"),true);
  assert.ok(h.status.textContent.includes("Beat-aligned"));
});

test("turning Follow off disables automatic scrolling, not note highlighting",()=>{
  const h=harness(),a=h.glyph(.25,{y:420}),b=h.glyph(.25,{x:140,y:420});
  h.follow.attach(mappedResult(),h.tune(h.group([[a,b]])));
  h.follow.setPlayback(.5,true,true);assert.ok(h.root.scrollCalls.length>0);
  h.button.dispatch("click");assert.equal(h.button.getAttribute("aria-pressed"),"false");
  const previous=h.root.scrollCalls.length;h.follow.setPlayback(1.5,true,true);
  assert.equal(h.root.scrollCalls.length,previous);assert.equal(b.element.classList.contains("score-note-active"),true);
  assert.ok(h.status.textContent.includes("Auto-scroll off"));
});

test("follow scrolls only the score viewport and cursor geometry follows its coordinate origin",()=>{
  const h=harness(),a=h.glyph(.5,{x:170,y:430});
  h.follow.attach(mappedResult(),h.tune(h.group([[a]])));h.follow.setPlayback(1,true,true);
  assert.deepEqual(h.root.scrollCalls.at(-1),{top:289,behavior:"smooth"});
  assert.equal(h.cursor().style.left,"116px");assert.equal(h.cursor().style.top,"324px");assert.equal(h.cursor().style.height,"30px");
});

test("hidden panels do not update glyphs until made visible, then refresh the current position",()=>{
  const h=harness(),a=h.glyph(.25),b=h.glyph(.25,{x:140});
  h.follow.attach(mappedResult(),h.tune(h.group([[a,b]])));h.follow.setPlayback(.5,true,true);
  const before=h.status.textContent;h.follow.setPlayback(1.5,true,false);
  assert.equal(h.status.textContent,before);assert.equal(a.element.classList.contains("score-note-active"),true);
  assert.equal(b.element.classList.contains("score-note-active"),false);
  h.follow.setPlayback(1.5,true,true);assert.equal(a.element.classList.contains("score-note-active"),false);assert.equal(b.element.classList.contains("score-note-active"),true);
});

test("resize repositions the cursor even if the active musical state is unchanged",()=>{
  const h=harness(),a=h.glyph(.5,{x:100});h.follow.attach(mappedResult(),h.tune(h.group([[a]])));
  h.follow.setPlayback(.5,false,true);assert.equal(h.cursor().style.left,"46px");
  a.element.rect.left=180;h.follow.resize();assert.equal(h.cursor().style.left,"126px");
});

test("the status clock advances during sustained notes without retriggering scroll or highlights",()=>{
  const h=harness(),a=h.glyph(.75,{y:420});h.follow.attach(mappedResult(),h.tune(h.group([[a]])));
  h.follow.setPlayback(.25,true,true);
  assert.ok(h.status.textContent.includes("0:00.25 · Measure 1"));
  const scrollCount=h.root.scrollCalls.length,classes=a.element.className,cursorTop=h.cursor().style.top;
  h.follow.setPlayback(.875,true,true);
  assert.ok(h.status.textContent.includes("0:00.88 · Measure 1"));
  assert.equal(a.element.className,classes);assert.equal(h.cursor().style.top,cursorTop);assert.equal(h.root.scrollCalls.length,scrollCount);
});

test("reset removes highlights, cursor, and stale seek actions",()=>{
  const h=harness(),a=h.glyph(.5);h.follow.attach(mappedResult(),h.tune(h.group([[a]])));h.follow.setPlayback(.5,true,true);
  assert.equal(a.element.classList.contains("score-note-active"),true);h.follow.reset();
  assert.equal(a.element.classList.contains("score-note-active"),false);assert.equal(h.cursor(),undefined);assert.equal(h.button.disabled,true);
  assert.equal(a.element.classList.contains("score-seekable"),false);
  for(const attribute of["role","tabindex","aria-label"])assert.equal(a.element.getAttribute(attribute),null);
  h.root.dispatch("click",{target:a.child});h.root.dispatch("keydown",{target:a.element,key:"Enter"});assert.equal(h.seeks.length,0);
  h.follow.setPlayback(.6,true,true);assert.equal(a.element.classList.contains("score-note-active"),false);
});

test("reset restores preexisting SVG accessibility attributes instead of deleting them",()=>{
  const h=harness(),a=h.glyph(.5);
  a.element.setAttribute("role","graphics-symbol");a.element.setAttribute("tabindex","-1");a.element.setAttribute("aria-label","Original score note");
  h.follow.attach(mappedResult(),h.tune(h.group([[a]])));assert.equal(a.element.getAttribute("role"),"button");
  h.follow.reset();assert.equal(a.element.getAttribute("role"),"graphics-symbol");assert.equal(a.element.getAttribute("tabindex"),"-1");assert.equal(a.element.getAttribute("aria-label"),"Original score note");
});

test("revealing a hidden panel refreshes geometry even within the same sustained note",()=>{
  const h=harness(),a=h.glyph(.75,{x:100});h.follow.attach(mappedResult(),h.tune(h.group([[a]])));
  h.follow.setPlayback(.5,false,true);assert.equal(h.cursor().style.left,"46px");
  h.follow.setPlayback(.6,false,false);a.element.rect.left=180;
  h.follow.setPlayback(.6,false,true);assert.equal(h.cursor().style.left,"126px");
});

test("attaching a replacement score cannot trigger actions on the previous glyphs",()=>{
  const h=harness(),old=h.glyph(.5),replacement=h.glyph(.25);
  h.follow.attach(mappedResult(),h.tune(h.group([[old]])));h.follow.setPlayback(.5,false,true);
  h.follow.attach(mappedResult(),h.tune(h.group([[replacement]])));
  h.root.dispatch("click",{target:old.child});assert.equal(h.seeks.length,0);
  h.root.dispatch("click",{target:replacement.child});assert.equal(h.seeks.length,1);
  assert.equal(old.element.classList.contains("score-note-active"),false);
});

test("outside-score playback clears highlighting and cursor without stopping original audio",()=>{
  const h=harness(),a=h.glyph(.5);h.follow.attach(mappedResult(),h.tune(h.group([[a]])));h.follow.setPlayback(.5,true,true);
  h.follow.setPlayback(9,true,true);assert.equal(a.element.classList.contains("score-note-active"),false);assert.equal(h.cursor().hidden,true);
  assert.ok(h.status.textContent.includes("Original audio continues"));
});

test("legacy measure-only alignment is clearly labeled approximate",()=>{
  const h=harness(),a=h.glyph(.5);h.follow.attach(mappedResult({exact:false}),h.tune(h.group([[a]])));h.follow.setPlayback(.5,false,true);
  assert.ok(h.status.textContent.includes("Approximate measure timing"));
});

test("cursor chooses the newest onset's staff when another voice sustains across systems",()=>{
  const h=harness(),sustained=h.glyph(1.5,{x:80,y:140}),first=h.glyph(1,{x:100,y:140}),second=h.glyph(.5,{x:120,y:420});
  const g0=h.group([[sustained],[first]],0),g1=h.group([[],[second]],1);
  h.follow.attach(mappedResult(),h.tune(g0,g1));h.follow.setPlayback(4.5,true,true);
  assert.equal(sustained.element.classList.contains("score-note-active"),true);assert.equal(second.element.classList.contains("score-note-active"),true);
  assert.equal(h.cursor().style.top,"314px");assert.equal(h.cursor().style.height,"30px");
});
