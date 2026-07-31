// main.web.tsx が window.api を用意し終えてから読み込むモジュール。
// video/init は import しただけで features/registry へ登録し、その過程で
// video/api.ts が window.api を掴むため、ここに隔離して読み込み順を保証する。
import '../video/init'
export { default } from '../App'
