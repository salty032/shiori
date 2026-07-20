"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const path_1 = require("path");
const electron_vite_1 = require("electron-vite");
const plugin_react_1 = __importDefault(require("@vitejs/plugin-react"));
exports.default = (0, electron_vite_1.defineConfig)({
    main: {
        build: {
            rollupOptions: {
                input: {
                    index: (0, path_1.resolve)('src/main/index.ts')
                }
            }
        },
        plugins: [(0, electron_vite_1.externalizeDepsPlugin)()]
    },
    preload: {
        build: {
            rollupOptions: {
                input: {
                    index: (0, path_1.resolve)('src/preload/index.ts'),
                    recorder: (0, path_1.resolve)('src/preload/recorder.ts')
                }
            }
        },
        plugins: [(0, electron_vite_1.externalizeDepsPlugin)()]
    },
    renderer: {
        build: {
            rollupOptions: {
                input: {
                    index: (0, path_1.resolve)('src/renderer/index.html'),
                    recorder: (0, path_1.resolve)('src/renderer/recorder.html')
                }
            }
        },
        resolve: {
            alias: {
                '@renderer': (0, path_1.resolve)('src/renderer/src')
            }
        },
        plugins: [(0, plugin_react_1.default)()]
    }
});
