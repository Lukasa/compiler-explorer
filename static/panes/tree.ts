// Copyright (c) 2021, Compiler Explorer Authors
// All rights reserved.
//
// Redistribution and use in source and binary forms, with or without
// modification, are permitted provided that the following conditions are met:
//
//     * Redistributions of source code must retain the above copyright notice,
//       this list of conditions and the following disclaimer.
//     * Redistributions in binary form must reproduce the above copyright
//       notice, this list of conditions and the following disclaimer in the
//       documentation and/or other materials provided with the distribution.
//
// THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
// AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
// IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE
// ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE
// LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR
// CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF
// SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS
// INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN
// CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE)
// ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE
// POSSIBILITY OF SUCH DAMAGE.

import { MultifileFile, MultifileService, MultifileServiceState } from "../multifile-service";
import { saveAs } from "file-saver";
import { LineColouring } from "../line-colouring";

const _ = require('underscore');
const $ = require('jquery');
const Alert = require('../alert');
const Components = require('../components');
const local = require('../local');
const ga = require('../analytics');
const TomSelect = require('tom-select');
const Toggles = require('../toggles');
const options = require('../options');
const languages = options.languages;
const saveAs = require('file-saver').saveAs;

declare global {
    interface Window { httpRoot: any; }
}

export class TreeState extends MultifileServiceState {
    id: number
    cmakeArgs: string;
    customOutputFilename: string;
}

export class Tree {
    private id: number;
    private container: any;
    private domRoot: any;
    private hub: any;
    private eventHub: any;
    private settings: any;
    private httpRoot: any;
    private alertSystem: any;
    private root: any;
    private rowTemplate: any;
    private namedItems: any;
    private unnamedItems: any;
    private langKeys: string[];
    private cmakeArgsInput: any;
    private customOutputFilenameInput: any;
    public multifileService: MultifileService;
    private lineColouring: LineColouring;
    private ourCompilers: {};
    private busyCompilers: {};
    private asmByCompiler: {};
    private selectize: any;
    private languageBtn: any;
    private toggleCMakeButton: any;
    private debouncedEmitChange: () => void;

    constructor(hub, state: TreeState, container) {
        this.id = state.id || hub.nextTreeId();
        this.container = container;
        this.domRoot = container.getElement();
        this.domRoot.html($('#filelisting').html());
        this.hub = hub;
        this.eventHub = hub.createEventHub();
        this.settings = JSON.parse(local.get('settings', '{}'));

        this.httpRoot = window.httpRoot;

        this.alertSystem = new Alert();
        this.alertSystem.prefixMessage = 'Tree #' + this.id + ': ';

        this.root = this.domRoot.find('.tree');
        this.rowTemplate = $('#filelisting-editor-tpl');
        this.namedItems = this.domRoot.find('.named-editors');
        this.unnamedItems = this.domRoot.find('.unnamed-editors');

        this.langKeys = _.keys(languages);

        this.cmakeArgsInput = this.domRoot.find('.cmake-arguments');
        this.customOutputFilenameInput = this.domRoot.find('.cmake-customOutputFilename');

        const usableLanguages = _.filter(languages, (language) => {
            return hub.compilerService.compilersByLang[language.id];
        });

        if (state) {
            if (!state.compilerLanguageId) {
                state.compilerLanguageId = this.settings.defaultLanguage;
            }
        } else {
            state = {
                id: this.id,
                customOutputFilename: '',
                cmakeArgs: '',
                compilerLanguageId: this.settings.defaultLanguage,
                isCMakeProject: false,
                files: [],
                newFileId: 1,
            };
        }

        this.multifileService = new MultifileService(this.hub, this.alertSystem, state);
        this.lineColouring = new LineColouring(this.multifileService);
        this.ourCompilers = {};
        this.busyCompilers = {};
        this.asmByCompiler = {};

        this.initInputs(state);
        this.initButtons(state);
        this.initCallbacks();
        this.onSettingsChange(this.settings);

        this.selectize = new TomSelect(this.languageBtn, {
            sortField: 'name',
            valueField: 'id',
            labelField: 'name',
            searchField: ['name'],
            options: _.map(usableLanguages, _.identity),
            items: [this.multifileService.getLanguageId()],
            dropdownParent: 'body',
            plugins: ['input_autogrow'],
            onChange: _.bind(this.onLanguageChange, this),
        });

        this.updateTitle();
        this.onLanguageChange(this.multifileService.getLanguageId());

        ga.proxy('send', {
            hitType: 'event',
            eventCategory: 'OpenViewPane',
            eventAction: 'Tree',
        });

        this.refresh();
        this.eventHub.emit('findEditors');
    }

    private initInputs(state: TreeState) {
        if (state) {
            if (state.cmakeArgs) {
                this.cmakeArgsInput.val(state.cmakeArgs);
            }

            if (state.customOutputFilename) {
                this.customOutputFilenameInput.val(state.customOutputFilename);
            }
        }
    }

    private getCmakeArgs(): string {
        return this.cmakeArgsInput.val();
    }

    private getCustomOutputFilename(): string {
        return this.customOutputFilenameInput.val();
    }

    public currentState(): TreeState {
        return {
            id: this.id,
            cmakeArgs: this.getCmakeArgs(),
            customOutputFilename: this.getCustomOutputFilename(),
            ... this.multifileService.getState()
        }
    };

    private updateState() {
        const state = this.currentState();
        this.container.setState(state);

        this.updateButtons(state);
    }

    private initCallbacks() {
        this.container.on('resize', this.resize, this);
        this.container.on('shown', this.resize, this);
        this.container.on('open', () => {
            this.eventHub.emit('treeOpen', this.id);
        });
        this.container.on('destroy', this.close, this);

        this.eventHub.on('editorOpen', this.onEditorOpen, this);
        this.eventHub.on('editorClose', this.onEditorClose, this);
        this.eventHub.on('compilerOpen', this.onCompilerOpen, this);
        this.eventHub.on('compilerClose', this.onCompilerClose, this);

        this.eventHub.on('compileResult', this.onCompileResponse, this);

        this.toggleCMakeButton.on('change', _.bind(this.onToggleCMakeChange, this));

        this.cmakeArgsInput.on('change', _.bind(this.updateCMakeArgs, this));
        this.customOutputFilenameInput.on('change', _.bind(this.updateCustomOutputFilename, this));
    }

    private updateCMakeArgs() {
        this.updateState();

        this.debouncedEmitChange();
    }

    private updateCustomOutputFilename() {
        this.updateState();

        this.debouncedEmitChange();
    }

    private onToggleCMakeChange() {
        const isOn = this.toggleCMakeButton.state.isCMakeProject;
        this.multifileService.setAsCMakeProject(isOn);

        this.domRoot.find('.cmake-project').prop('title',
            '[' + (isOn ? 'ON' : 'OFF') + '] CMake project');
        this.updateState();
    }

    private onLanguageChange(newLangId: string) {
        if (languages[newLangId]) {
            this.multifileService.setLanguageId(newLangId);
            this.eventHub.emit('languageChange', false, newLangId, this.id);
        }

        this.toggleCMakeButton.enableToggle('isCMakeProject', this.multifileService.isCompatibleWithCMake());

        this.refresh();
    }

    private sendCompilerChangesToEditor(compilerId: number) {
        this.multifileService.forEachOpenFile((file: MultifileFile) => {
            if (file.isIncluded) {
                this.eventHub.emit('treeCompilerEditorIncludeChange', this.id, file.editorId, compilerId);
            } else {
                this.eventHub.emit('treeCompilerEditorExcludeChange', this.id, file.editorId, compilerId);
            }
        });

        this.eventHub.emit('resendCompilation', compilerId);
    }

    private sendCompileRequests() {
        this.eventHub.emit('requestCompilation', false, this.id);
    }

    private sendChangesToAllEditors() {
        _.each(this.ourCompilers, (unused, compilerId: string) => {
            this.sendCompilerChangesToEditor(parseInt(compilerId));
        });
    }

    private onCompilerOpen(compilerId: number, unused, treeId: number) {
        if (treeId === this.id) {
            this.ourCompilers[compilerId] = true;
            this.sendCompilerChangesToEditor(compilerId);
        }
    }

    private onCompilerClose(compilerId: number, unused, treeId: number) {
        if (treeId === this.id) {
            delete this.ourCompilers[compilerId];
        }
    }

    private onEditorOpen(editorId: number) {
        const file = this.multifileService.getFileByEditorId(editorId);
        if (file) return;

        this.multifileService.addFileForEditorId(editorId);
        this.refresh();
        this.sendChangesToAllEditors();
    }

    private onEditorClose(editorId: number) {
        const file = this.multifileService.getFileByEditorId(editorId);

        if (file) {
            file.isOpen = false;
            const editor = this.hub.getEditorById(editorId);
            file.langId = editor.currentLanguage.id;
            file.content = editor.getSource();
            file.editorId = -1;
        }

        this.refresh();
    }

    private removeFile(fileId: number) {
        const file = this.multifileService.removeFileByFileId(fileId);
        if (file) {
            if (file.isOpen) {
                const editor = this.hub.getEditorById(file.editorId);
                if (editor) {
                    editor.container.close();
                }
            }
        }

        this.refresh();
    }

    private addRowToTreelist(file: MultifileFile) {
        const item = $(this.rowTemplate.children()[0].cloneNode(true));
        const stagingButton = item.find('.stage-file');
        const renameButton = item.find('.rename-file');
        const deleteButton = item.find('.delete-file');

        item.data('fileId', file.fileId);
        if (file.filename) {
            item.find('.filename').html(file.filename);
        } else if (file.editorId > 0) {
            const editor = this.hub.getEditorById(file.editorId);
            if (editor) {
                item.find('.filename').html(editor.getPaneName());
            } else {
                // wait for editor to appear first
                return;
            }
        } else {
            item.find('.filename').html('Unknown file');
        }

        item.on('click', (e) => {
            const fileId = $(e.currentTarget).data('fileId');
            this.editFile(fileId);
        });

        renameButton.on('click', async (e) => {
            const fileId = $(e.currentTarget).parent('li').data('fileId');
            await this.multifileService.renameFile(fileId);
            this.refresh();
        });

        deleteButton.on('click', (e) => {
            const fileId = $(e.currentTarget).parent('li').data('fileId');
            const file = this.multifileService.getFileByFileId(fileId);
            if (file) {
                this.alertSystem.ask('Delete file', 'Are you sure you want to delete ' + file.filename, {
                    yes: () => {
                        this.removeFile(fileId);
                    },
                });
            }
        });

        if (file.isIncluded) {
            stagingButton.removeClass('fa-plus').addClass('fa-minus');
            stagingButton.on('click', async (e) => {
                const fileId = $(e.currentTarget).parent('li').data('fileId');
                await this.moveToExclude(fileId);
            });
            this.namedItems.append(item);
        } else {
            stagingButton.removeClass('fa-minus').addClass('fa-plus');
            stagingButton.on('click', async (e) => {
                const fileId = $(e.currentTarget).parent('li').data('fileId');
                await this.moveToInclude(fileId);
            });
            this.unnamedItems.append(item);
        }
    }

    private refresh() {
        this.updateState();

        this.namedItems.html('');
        this.unnamedItems.html('');

        this.multifileService.forEachFile((file: MultifileFile) => this.addRowToTreelist(file));
    }

    private editFile(fileId: number) {
        const file = this.multifileService.getFileByFileId(fileId);
        if (!file.isOpen) {
            const dragConfig = this.getConfigForNewEditor(file);
            file.isOpen = true;

            this.hub.addInEditorStackIfPossible(dragConfig);
        } else {
            const editor = this.hub.getEditorById(file.editorId);
            this.hub.activateTabForContainer(editor.container);
        }

        this.sendChangesToAllEditors();
    }

    private async moveToInclude(fileId: number) {
        await this.multifileService.includeByFileId(fileId);

        this.refresh();
        this.sendChangesToAllEditors();
    }

    private async moveToExclude(fileId: number) {
        await this.multifileService.excludeByFileId(fileId);
        this.refresh();
        this.sendChangesToAllEditors();
    }

    private bindClickToOpenPane(dragSource, dragConfig) {
        dragSource.on('click', () => {
            this.hub.addInEditorStackIfPossible(_.bind(dragConfig, this));
        });
    }

    private getConfigForNewCompiler() {
        return Components.getCompilerForTree(this.id, this.currentState().compilerLanguageId);
    }

    private getConfigForNewExecutor() {
        return Components.getExecutorForTree(this.id, this.currentState().compilerLanguageId);
    }

    private getConfigForNewEditor(file: MultifileFile) {
        let editor;
        const editorId = this.hub.nextEditorId();

        if (file) {
            file.editorId = editorId;
            editor = Components.getEditor(
                editorId,
                file.langId);

            editor.componentState.source = file.content;
            if (file.filename) {
                editor.componentState.customPaneName = file.filename;
            }
        } else {
            editor = Components.getEditor(
                editorId,
                this.multifileService.getLanguageId());
        }

        return editor;
    }

    private getFormattedDateTime() {
        const d = new Date();

        let datestring = d.getFullYear() +
            ('0' + (d.getMonth() + 1)).slice(-2) +
            ('0' + d.getDate()).slice(-2);
        datestring += ('0' + d.getHours()).slice(-2) +
            ('0' + d.getMinutes()).slice(-2) +
            ('0' + d.getSeconds()).slice(-2);

        return datestring;
    }

    private triggerSaveAs(blob) {
        const dt = this.getFormattedDateTime();
        saveAs(blob, `project-${dt}.zip`);
    }

    private initButtons(state: TreeState) {
        const addCompilerButton = this.domRoot.find('.add-compiler');
        const addExecutorButton = this.domRoot.find('.add-executor');
        const addEditorButton = this.domRoot.find('.add-editor');
        const saveProjectButton = this.domRoot.find('.save-project-to-file');

        saveProjectButton.on('click', () => {
            this.multifileService.saveProjectToZipfile(_.bind(this.triggerSaveAs, this));
        });

        const loadProjectFromFile = this.domRoot.find('.load-project-from-file');
        loadProjectFromFile.on('change', (e) => {
            const files = e.target.files;
            if (files.length > 0) {
                this.multifileService.forEachFile((file: MultifileFile) => {
                    this.removeFile(file.fileId);
                });

                this.multifileService.loadProjectFromFile(files[0], (file: MultifileFile) => {
                    this.refresh();
                    if (file.filename === 'CMakeLists.txt') {
                        // todo: find a way to toggle on CMake checkbox...
                        this.editFile(file.fileId);
                    }
                });
            }
        });

        this.bindClickToOpenPane(addCompilerButton, this.getConfigForNewCompiler);
        this.bindClickToOpenPane(addExecutorButton, this.getConfigForNewExecutor);
        this.bindClickToOpenPane(addEditorButton, this.getConfigForNewEditor);

        this.languageBtn = this.domRoot.find('.change-language');

        if (this.langKeys.length <= 1) {
            this.languageBtn.prop('disabled', true);
        }

        this.toggleCMakeButton = new Toggles(this.domRoot.find('.options'), state);
    }

    private numberUsedLines() {
        if (_.any(this.busyCompilers)) return;

        if (!this.settings.colouriseAsm) {
            this.updateColoursNone();
            return;
        }

        this.lineColouring.clear();

        _.each(this.asmByCompiler, (asm: any, compilerId: string) => {
            if (asm) this.lineColouring.addFromAssembly(parseInt(compilerId), asm);
        });

        this.lineColouring.calculate();

        this.updateColours();
    }

    private updateColours() {
        _.each(this.ourCompilers, (unused, compilerId: string) => {
            const id: number = parseInt(compilerId);
            this.eventHub.emit('coloursForCompiler', id,
                this.lineColouring.getColoursForCompiler(id), this.settings.colourScheme);
        });

        this.multifileService.forEachOpenFile((file: MultifileFile) => {
            this.eventHub.emit('coloursForEditor', file.editorId,
                this.lineColouring.getColoursForEditor(file.editorId), this.settings.colourScheme);
        });
    }

    private updateColoursNone() {
        _.each(this.ourCompilers, (unused, compilerId: string) => {
            this.eventHub.emit('coloursForCompiler', parseInt(compilerId), {}, this.settings.colourScheme);
        });

        this.multifileService.forEachOpenFile((file: MultifileFile) => {
            this.eventHub.emit('coloursForEditor', file.editorId, {}, this.settings.colourScheme);
        });
    }

    private onCompileResponse(compilerId: number, compiler, result) {
        if (!this.ourCompilers[compilerId]) return;

        this.busyCompilers[compilerId] = false;

        // todo: parse errors and warnings and relate them to lines in the code
        // note: requires info about the filename, do we currently have that?

        // eslint-disable-next-line max-len
        // {"text":"/tmp/compiler-explorer-compiler2021428-7126-95g4xc.zfo8p/example.cpp:4:21: error: expected ‘;’ before ‘}’ token"}

        if (result.result && result.result.asm) {
            this.asmByCompiler[compilerId] = result.result.asm;
        } else {
            this.asmByCompiler[compilerId] = result.asm;
        }

        this.numberUsedLines();
    }

    private updateButtons(state: TreeState) {
        if (state.isCMakeProject) {
            this.cmakeArgsInput.parent().removeClass('d-none');
            this.customOutputFilenameInput.parent().removeClass('d-none');
        } else {
            this.cmakeArgsInput.parent().addClass('d-none');
            this.customOutputFilenameInput.parent().addClass('d-none');
        }
    }

    private resize() {
    }

    private onSettingsChange(newSettings) {
        this.debouncedEmitChange = _.debounce(() => {
            this.sendCompileRequests();
        }, newSettings.delayAfterChange);
    }

    private getPaneName() {
        return `Tree #${this.id}`;
    }

    private updateTitle() {
        this.container.setTitle(this.getPaneName());
    }

    private close() {
        this.eventHub.unsubscribe();
        this.eventHub.emit('treeClose', this.id);
        this.hub.removeTree(this.id);
        $('#add-tree').prop('disabled', false);
    }
}