import test from 'node:test';
import assert from 'node:assert/strict';
import {looksLikeQuestion} from '../src/ocr-client.ts';
test('full pasted questions open recognition, search fragments remain normal search',()=>{
  for(const value of ['以下属于Navigation布局模式的有：\nA. 自适应\nB. 单栏','List容器可以沿水平方向排列，也可以沿垂直方向排列。','TabContent组件的高度由什么决定','使用隐式 Want 启动 UIAbility 时，以下说法错误的是？'])assert.equal(looksLikeQuestion(value),true,value);
  for(const value of ['Nav','@Component','UIAbility launchWant','颜色 组件',''])assert.equal(looksLikeQuestion(value),false,value);
});
