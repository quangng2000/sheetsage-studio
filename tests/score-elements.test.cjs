"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const {collect} = require("../desktop/ui/score-elements.js");
const abcjs = require("../desktop/ui/assets/abcjs-basic-min.js");

const glyph = (duration, options = {}) => ({
  type:options.rest ? "rest" : "note", duration:options.layoutDuration ?? duration,
  durationClass:duration, x:options.x ?? 20, w:12,
  elemset:options.elements ?? [{name:"svg-note"}],
  abcelem:{el_type:"note",duration,startChar:options.startChar ?? 0,endChar:options.endChar ?? 1,
    ...(options.rest ? {rest:{type:options.rest}} : {pitches:[{pitch:0,...options.pitch}]}), ...options.abcelem},
  ...options.absolute,
});
const bar = (type = "bar_thin") => ({type:"bar",duration:0,abcelem:{el_type:"bar",type}});
function group(voices, line = 0) {
  const staffs=voices.map(() => ({}));
  return {line,staffs,voices:voices.map((children,index)=>({children,staff:staffs[index],voicenumber:0}))};
}
const tune = (...groups) => ({engraver:{staffgroups:groups}});
const near = (actual,expected) => assert.ok(Math.abs(actual-expected)<1e-10, `${actual} != ${expected}`);

test("browser UMD exports a standalone adapter with no DOM requirement", () => {
  const context=vm.createContext({});
  vm.runInContext(fs.readFileSync(require.resolve("../desktop/ui/score-elements.js"),"utf8"),context);
  assert.equal(typeof context.ScoreElements.collect,"function");
  assert.deepEqual(collect(null),[]);
  assert.deepEqual(collect(abcjs.parseOnly("X:1\nK:C\nCDEF|")[0]),[]);
});

test("whole-note coordinates ignore tempo and maintain independent sustained voice lifetimes", () => {
  const first=glyph(.75), second=glyph(.25);
  const result=collect(tune(group([[first,bar(),second],[glyph(.25),glyph(.25),glyph(.25),bar(),glyph(.25)]])));
  assert.equal(result.length,6);
  const sustained=result.find((item)=>item.absoluteElement===first);
  assert.equal(sustained.start,0); assert.equal(sustained.end,.75);
  assert.equal(result.filter((item)=>item.start<=.5&&item.end>.5).length,2);
  assert.equal(result.find((item)=>item.absoluteElement===second).measureIndex,1);
});

test("bar lines never reset time and each voice continues across printed systems", () => {
  const result=collect(tune(group([[bar(),glyph(.5),bar()],[glyph(.25),glyph(.25),bar()]],0),group([[glyph(.25),bar()],[glyph(.5),bar()]],1)));
  assert.deepEqual(result.filter((item)=>item.voice===0).map((item)=>[item.start,item.end,item.measureIndex,item.lineIndex]),[[0,.5,0,0],[.5,.75,1,1]]);
  assert.deepEqual(result.filter((item)=>item.voice===1).map((item)=>[item.start,item.end]),[[0,.25],[.25,.5],[.5,1]]);
});

test("multiple voices on one staff use local voice numbers, not just staff identity", () => {
  const staff={};
  const groups=[0,1].map((line)=>({line,staffs:[staff],voices:[{staff,voicenumber:0,children:[glyph(.5)]},{staff,voicenumber:1,children:[glyph(.25)]}]}));
  const result=collect(tune(...groups));
  assert.deepEqual(result.filter((item)=>item.voiceKey==="0:0").map((item)=>item.start),[0,.5]);
  assert.deepEqual(result.filter((item)=>item.voiceKey==="0:1").map((item)=>item.start),[0,.25]);
});

test("durationClass preserves compound-meter multimeasure rest duration despite layout duration=1", () => {
  const rest=glyph(1.5,{layoutDuration:1,rest:"multimeasure"});
  const result=collect(tune(group([[rest,glyph(.25)]])));
  assert.equal(result[0].rest,true); assert.equal(result[0].end,1.5);
  assert.equal(result[1].start,1.5);
});

test("tuplets use engraved durationClass, while spacer and zero-duration notes consume no time", () => {
  const triplets=[0,1,2].map(()=>glyph(1/12,{abcelem:{duration:1/8}}));
  const result=collect(tune(group([[glyph(.25,{rest:"spacer"}),...triplets,glyph(.25,{abcelem:{duration:0}}),glyph(.25)]])));
  assert.equal(result.length,4);
  near(result[3].start,.25); near(result[3].end,.5);
});

test("tied continuations retain separate glyph windows and exact source positions", () => {
  const start=glyph(.25,{pitch:{startTie:{}},startChar:10,endChar:13});
  const end=glyph(.25,{pitch:{endTie:true},startChar:14,endChar:16});
  const result=collect(tune(group([[start,bar(),end]])));
  assert.equal(result.length,2);assert.equal(result[0].tieStart,true);assert.equal(result[1].tieEnd,true);
  assert.equal(result[1].start,.25);assert.equal(result[1].measureIndex,1);
  assert.equal(result[1].startChar,14);assert.equal(result[1].endChar,16);
  assert.notEqual(result[0].elements[0],result[1].elements[0]);
});

test("rests including invisible rests retain score time; duplicate SVG references are deduplicated per glyph", () => {
  const element={name:"svg-group"};
  const result=collect(tune(group([[glyph(.25,{elements:[element,null,element]}),glyph(.5,{rest:"invisible",elements:[]}),glyph(.25)]])));
  assert.equal(result[0].elements.length,1);assert.equal(result[0].elements[0],element);
  assert.equal(result[1].rest,true);assert.equal(result[1].elements.length,0);assert.equal(result[2].start,.75);
});

test("hints and tablature staves are ignored without perturbing score clocks", () => {
  const rendered=group([[glyph(.25,{absolute:{hint:true}}),glyph(.5)],[glyph(.25)]]);
  rendered.voices[1].staff.isTabStaff=true;
  const result=collect(tune(rendered));
  assert.equal(result.length,1);assert.equal(result[0].start,0);assert.equal(result[0].end,.5);
});

test("repeat glyphs are not silently expanded into a second visual performance", () => {
  const result=collect(tune(group([[bar("bar_left_repeat"),glyph(.25),bar("bar_right_repeat"),glyph(.25)]])));
  assert.equal(result.length,2);assert.equal(result[1].start,.25);
});

test("actual abcjs parseOnly durations sanity-check tuplets and 6/8 rest arithmetic", () => {
  // Model the exact AbsoluteElement durationClass contract from the pinned
  // engraver while using the bundled parser's real ABC representation.
  const parsed=abcjs.parseOnly("X:1\nM:6/8\nL:1/8\nQ:1/4=120\nK:C\n(3CDE z6 | Z2 | A2- A2 |")[0];
  let multiplier=1;
  const children=parsed.lines[0].staff[0].voices[0].map((abcelem)=>{
    if(abcelem.el_type==="bar")return {type:"bar",duration:0,abcelem};
    if(abcelem.startTriplet)multiplier=abcelem.tripletMultiplier;
    const durationClass=abcelem.duration*multiplier;
    if(abcelem.endTriplet)multiplier=1;
    return {type:abcelem.rest?"rest":"note",duration:abcelem.rest?.type==="multimeasure"?1:durationClass,durationClass,abcelem,elemset:[{}]};
  });
  const result=collect(tune(group([children])));
  assert.equal(parsed.getBeatLength(),.375);
  near(result[3].start,.25);near(result[3].end,1);
  near(result[4].start,1);near(result[4].end,2.5);
  near(result[5].start,2.5);near(result[6].start,2.75);
  assert.equal(result[5].tieStart,true);assert.equal(result[6].tieEnd,true);
});
