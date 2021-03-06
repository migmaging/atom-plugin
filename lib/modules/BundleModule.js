'use babel';

import queue from 'queue';
import { keys, isEmpty } from 'lodash';

import { Store } from './Store';
import { FileWatcher } from '../watchers/FileWatcher';
import { HttpModule } from './HttpModule';
import { CommonUtils } from './CommonUtils';
import { Analyser } from './Analyser';
import { Logger } from './Logger';

import { PLUGIN } from '../constants/common';
import { CUSTOM_EVENTS, STORE_KEYS } from '../constants/store';
import { BUNDLE_ERRORS } from '../constants/messages';

class BundleModule {

  loopTimeout = null;
  bundleLoopStarted = false;
  changedFiles = [];
  removedFiles = [];

  processedChunks = {}; // cache for processed and stored chunks
  uploadQueueFinished = false;
  uploadQueueErrors = false;

  constructor() {
    Store.on(CUSTOM_EVENTS.didScanSingleFolder, async () => {
      await this.restartBundleLoop();
    });
  }

  async getBundleID() {
    const bundleID = Store.get(STORE_KEYS.bundleID);
    return Promise.resolve(bundleID);
  }

  async setBundleID(bundleID) {
    Store.set(STORE_KEYS.bundleID, bundleID);
    return Promise.resolve();
  }

  async getSessionToken() {
    const sessionToken = Store.get(STORE_KEYS.sessionToken);
    return Promise.resolve(sessionToken);
  }

  async isLoopBlocked() {
    const scanningInProcess = Store.get(STORE_KEYS.scanningInProcess);
    const uploadInProgress = Store.get(STORE_KEYS.uploadInProgress);
    const analysisInProgress = Store.get(STORE_KEYS.analysisInProgress);
    const testingInProgress = Store.get(STORE_KEYS.testEnvironment);

    const isBlocked = (scanningInProcess || uploadInProgress || analysisInProgress || testingInProgress);

    return Promise.resolve(isBlocked);
  }

  async updateState() {
    const { changedFiles, removedFiles } = FileWatcher.getState();

    this.changedFiles = changedFiles;
    this.removedFiles = removedFiles;

    return Promise.resolve();
  }

  async resetState() {
    this.changedFiles = [];
    this.removedFiles = [];

    return Promise.resolve();
  }

  async startBundleLoop() {
    if (this.loopTimeout) {
      clearTimeout(this.loopTimeout);
    }

    const isBlocked = await this.isLoopBlocked();
    if (isBlocked) {
      await this.nextBundleLoopTick();
      return Promise.resolve();
    }

    await this.updateState();
    if (isEmpty(this.changedFiles)) {
      Logger.log('No changed files to create/extend bundle');
      await this.nextBundleLoopTick();
      return Promise.resolve();
    }

    if (!this.bundleLoopStarted) {
      Logger.log('Bundle loop started successfully');
      this.bundleLoopStarted = true;
    }

    let bundleID = await this.getBundleID();

    // creating new bundle
    if (!bundleID) {
      bundleID = await this.createBundle();
      if (!bundleID) {
        await this.nextBundleLoopTick();
        return Promise.resolve();
      }

      await FileWatcher.synchronizeBundle(this.changedFiles);
      await this.resetState();
      await this.setBundleID(bundleID);
    }

    await CommonUtils.sleep(100);

    // checking and extending existed bundle
    bundleID = await this.checkBundle(bundleID);
    if (!bundleID) {
      await this.nextBundleLoopTick();
      return Promise.resolve();
    }

    await this.setBundleID(bundleID);

    // start analysis
    setTimeout(async () => {
      await Analyser.startAnalysisLoop();
    }, 0);

    // plan next iteration and return
    await this.nextBundleLoopTick();
    return Promise.resolve();
  }

  async nextBundleLoopTick() {
    if (this.loopTimeout) {
      clearTimeout(this.loopTimeout);
    }

    this.loopTimeout = setTimeout(async () => {
      await this.startBundleLoop();
    }, PLUGIN.analysisDelay);

    return Promise.resolve();
  }

  async restartBundleLoop() {
    if (this.loopTimeout) {
      clearTimeout(this.loopTimeout);
    }

    await this.startBundleLoop();

    return Promise.resolve();
  }

  async stopBundleLoop() {
    if (this.loopTimeout) {
      clearTimeout(this.loopTimeout);
    }

    this.loopTimeout = null;
    return Promise.resolve();
  }

  async createBundle() {
    const sessionToken = await this.getSessionToken();

    // creating new bundle
    const { files } = await FileWatcher.buildBundle(this.changedFiles);
    if (keys(files).length === 0) {
      return Promise.resolve(null);
    }

    const { error, statusCode, bundleId, uploadURL } = await HttpModule.createBundle(sessionToken, { files });
    if (statusCode !== 200) {
      Logger.log(BUNDLE_ERRORS.create[statusCode]);
      Logger.log(error);
      return Promise.resolve(null);
    }

    // upload files
    const resBundleID = await this.uploadFiles(bundleId, files, uploadURL);
    return Promise.resolve(resBundleID);
  }

  async checkBundle(bundleID) {
    const sessionToken = await this.getSessionToken();

    const response = await HttpModule.checkBundle(sessionToken, bundleID);
    const { error, statusCode } = response;

    // access error
    if (statusCode === 401 || statusCode === 403) {
      Logger.log(BUNDLE_ERRORS.check[statusCode]);
      Logger.log(error);
      return Promise.resolve(null);
    }

    // expired bundle
    if (statusCode === 404) {
      const newBundleID = await this.createBundle();
      return Promise.resolve(newBundleID);
    }

    // extend current bundle with new changed files
    const resBundleID = await this.extendBundle(bundleID);
    return Promise.resolve(resBundleID);
  }

  async extendBundle(bundleID) {
    const sessionToken = await this.getSessionToken();

    const { files } = await FileWatcher.buildBundle(this.changedFiles);
    if (keys(files).length === 0) {
      return Promise.resolve(bundleID);
    }

    const requestBody = {
      files,
      removedFiles: this.removedFiles,
    };
    const response = await HttpModule.extendBundle(sessionToken, bundleID, requestBody);
    const { error, statusCode, bundleId, uploadURL } = response;
    if (statusCode !== 200) {
      Logger.log(BUNDLE_ERRORS.extend[statusCode]);
      Logger.log(error);
      return Promise.resolve(null);
    }

    // upload files
    const resBundleID = await this.uploadFiles(bundleId, files, uploadURL);
    if (resBundleID) {
      await FileWatcher.synchronizeBundle(this.changedFiles, this.removedFiles);
    }

    return Promise.resolve(resBundleID);
  }

  async uploadFiles(bundleID, files, uploadURL) {
    this.uploadQueueFinished = false;
    this.uploadQueueErrors = false;

    const totalFiles = keys(files).length;
    this.processedChunks = {}; // cache for processed and stored chunks

    Store.setMany({
      [STORE_KEYS.uploadInProgress]: true,
      [STORE_KEYS.uploadCompleted]: 0,
      [STORE_KEYS.uploadTotal]: totalFiles,
    });

    // upload files:
    // 1. generate chunks from files: max 4 MB
    const chunks = await this.createUploadChunks(files);

    // 2. generate and start queue
    const uploadQueue = await this.createUploadQueue(chunks, uploadURL);

    uploadQueue.on('success', result => {
      const { chunkNumber, filesCount } = result;
      if (this.processedChunks[chunkNumber]) {
        return;
      }

      const uploadCompleted = Store.get(STORE_KEYS.uploadCompleted);
      const newResult = uploadCompleted + filesCount;

      Store.set(STORE_KEYS.uploadCompleted, newResult);
      this.processedChunks[chunkNumber] = true;
    });

    uploadQueue.on('end', () => {
      Logger.log('Upload Queue results:');
      uploadQueue.results.forEach((debugInfo, index) => {
        if (debugInfo.error) {
          this.uploadQueueErrors = true;
        }
        Logger.log(`- Result ${index}: `, debugInfo);
      });

      this.uploadQueueFinished = true;
    });

    uploadQueue.start();

    // wait for upload queue is finished
    return new Promise(resolve => {
      const interval = setInterval(() => {
        if (this.uploadQueueFinished) {
          const resultBundleID = this.uploadQueueErrors ? null : bundleID;
          clearInterval(interval);

          Store.set(STORE_KEYS.uploadInProgress, false);
          resolve(resultBundleID);
        }
      }, 200);
    });
  }

  async createUploadChunks(files) {
    const paths = keys(files);
    const projectFiles = FileWatcher.getProjectFiles(paths, true);

    // creating an array
    const projectFilesList = keys(projectFiles).map(path => ({
      path,
      ...projectFiles[path],
    }));

    const chunks = [];
    let currentSize = 0;
    let currentChunk = [];
    projectFilesList.forEach(fileInfo => {
      const { size } = fileInfo;
      const nextSize = currentSize + size;
      if (nextSize >= PLUGIN.maxPayload) {
        chunks.push(currentChunk);
        currentSize = size;
        currentChunk = [fileInfo];
        return;
      }

      currentSize = nextSize;
      currentChunk.push(fileInfo);
    });

    if (currentChunk.length > 0) {
      chunks.push(currentChunk);
    }

    return chunks;
  }

  async createUploadQueue(chunks, uploadURL) {
    const sessionToken = await this.getSessionToken();
    const isTesting = Store.get(STORE_KEYS.testEnvironment);

    const q = queue({
      results: [],
      concurrency: 10,
      autostart: false,
    });

    chunks.forEach((chunk, index) => {
      let chunkSize = 0;
      const requestBody = chunk.map(fileItem => {
        const { hash, size, content } = fileItem;
        chunkSize += size;

        return {
          fileHash: hash,
          fileContent: content,
        };
      });
      const debugInfo = {
        requestBody,
        chunkSize,
        chunkNumber: index,
        filesCount: chunk.length,
        files: chunk.map(fileItem => fileItem.path),
      };

      q.push(async () => {
        if (!isTesting) {
          await CommonUtils.sleep(100);
        }
        const { error, statusCode } = await HttpModule.uploadFiles(sessionToken, uploadURL, requestBody);
        if (statusCode !== 200) {
          debugInfo.errorText = BUNDLE_ERRORS.upload[statusCode] || error.message;
          debugInfo.error = error;
        }
        return debugInfo;
      });
    });

    return q;
  }
}

const BundleModuleInstance = new BundleModule();

export { BundleModuleInstance as BundleModule };
