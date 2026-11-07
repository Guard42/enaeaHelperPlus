// ==UserScript==
// @name         enaeaHelperPlus
// @namespace    http://tampermonkey.net/
// @version      0.8
// @license      MIT
// @description  make your life easier
// @author       SQHome-Jin
// @match        https://study.enaea.edu.cn/circleIndexRedirect.do*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
    'use strict';
    let currentPagePath = window.location.pathname;
    let playbackSpeed = 10; // Recommended speed: 2-4
    let checkInterval = 3000;
    let completedCoursesKey = 'enaeaHelperPlus.completedCourses';

    // 课程类型处理器：新增一种课程类型时，实现 name、matches、lessonUrl、study 四个成员并加入这个列表
    let courseHandlers = [createVideoCourseHandler(), createICourseHandler()];

    if (isContentsPage()) {
        startStudyRunner();
    }

    // 在课程目录页内逐门打开未完成的课程，学完一门再打开下一门
    async function startStudyRunner() {
        let circleId = getURLParameter('circleId');
        let syllabusId = getURLParameter('syllabusId');
        let listAction = getCourseListAction(getURLParameter('type'));
        let panel = createStudyPanel();
        startBackgroundKeepAlive(panel);
        while (true) {
            let courseItems = await fetchCourseList(listAction, circleId, syllabusId);
            let nextCourse = findNextCourse(courseItems, circleId);
            if (nextCourse.course === null) {
                finishStudyRunner(panel, nextCourse.unsupportedCourses);
                return;
            }
            let course = nextCourse.course;
            let handler = nextCourse.handler;
            let report = (message) => setStatus(panel, '[' + handler.name + '] ' + course.courseTitle + ' ' + message);
            report('开始学习');
            let historyBack = watchHistoryBack(report);
            let lessonFrame = openLesson(panel, handler.lessonUrl(course, circleId));
            await Promise.race([handler.study(lessonFrame, report), historyBack]);
            markCourseCompleted(circleId, course.courseId);
            lessonFrame.remove();
            setStatus(panel, '[' + handler.name + '] ' + course.courseTitle + ' 已完成');
        }
    }

    function finishStudyRunner(panel, unsupportedCourses) {
        if (unsupportedCourses.length === 0) {
            setStatus(panel, '全部课程已完成');
        } else {
            setStatus(panel, '可学习的课程已全部完成，以下课程类型不受支持：' + unsupportedCourses.join('；'));
        }
    }

    async function fetchCourseList(listAction, circleId, syllabusId) {
        let courseItems = [];
        while (true) {
            let url = '/circleIndex.do?action=' + listAction + '&start=' + courseItems.length + '&limit=200&isCompleted=&circleId=' + circleId
                + '&syllabusId=' + syllabusId + '&categoryRemark=all&_=' + Date.now();
            let data = await fetch(url).then((response) => response.json());
            courseItems = courseItems.concat(data.result.list);
            if (data.result.list.length === 0 || courseItems.length >= data.totalCount) {
                return courseItems;
            }
        }
    }

    // 课程列表中的进度会比学习页晚一段时间才更新，已由处理器确认学完的课程记录在 localStorage 中，避免重复打开
    function findNextCourse(courseItems, circleId) {
        let completedCourses = loadCompletedCourses();
        let unsupportedCourses = [];
        for (const item of courseItems) {
            let course = item.studyCenterDTO;
            if (Number(course.studyProgress) >= 100 || completedCourses.includes(circleId + ':' + course.courseId)) {
                continue;
            }
            let handler = courseHandlers.find((candidate) => candidate.matches(course));
            if (handler === undefined) {
                unsupportedCourses.push(course.courseTitle + '(' + course.coursecontentType + '/' + course.courseExternalType + ')');
                continue;
            }
            return { course: course, handler: handler, unsupportedCourses: unsupportedCourses };
        }
        return { course: null, handler: null, unsupportedCourses: unsupportedCourses };
    }

    function loadCompletedCourses() {
        return JSON.parse(localStorage.getItem(completedCoursesKey) || '[]');
    }

    function markCourseCompleted(circleId, courseId) {
        let completedCourses = loadCompletedCourses();
        completedCourses.push(circleId + ':' + courseId);
        localStorage.setItem(completedCoursesKey, JSON.stringify(completedCourses));
    }

    function createStudyPanel() {
        let panel = document.createElement('div');
        panel.style.cssText = 'position:fixed;left:1%;top:1%;width:98%;height:98%;z-index:2147483647;display:flex;flex-direction:column;background:#fff;border:2px solid #c0130d;';
        let statusBar = document.createElement('div');
        statusBar.id = 'enaeaHelperPlus-status';
        statusBar.style.cssText = 'padding:6px 12px;font-size:14px;line-height:20px;color:#fff;background:#c0130d;';
        let keepAliveBar = document.createElement('div');
        keepAliveBar.id = 'enaeaHelperPlus-keep-alive';
        keepAliveBar.style.cssText = 'padding:2px 12px;font-size:12px;line-height:18px;color:#fff;background:#8c0e09;cursor:pointer;';
        let frameContainer = document.createElement('div');
        frameContainer.style.cssText = 'flex:1;';
        panel.appendChild(statusBar);
        panel.appendChild(keepAliveBar);
        panel.appendChild(frameContainer);
        document.body.appendChild(panel);
        return { statusBar: statusBar, keepAliveBar: keepAliveBar, frameContainer: frameContainer };
    }

    // 页面被隐藏时(后台标签页、窗口最小化或被遮挡)浏览器会把定时器限制到约每分钟执行一次，平台计时几乎停止；
    // 正在播放声音的页面不受这种限制，这里持续输出一个 20 Hz、音量 0.001 的信号，低于人耳在该频率的听阈
    function startBackgroundKeepAlive(panel) {
        let audioContext = new AudioContext();
        let oscillator = audioContext.createOscillator();
        let gain = audioContext.createGain();
        oscillator.frequency.value = 20;
        gain.gain.value = 0.001;
        oscillator.connect(gain);
        gain.connect(audioContext.destination);
        oscillator.start();
        let showState = () => {
            if (audioContext.state === 'running') {
                panel.keepAliveBar.innerText = '后台计时保活已开启：页面被隐藏时平台计时不受影响';
            } else {
                panel.keepAliveBar.innerText = '后台计时保活未开启：浏览器要求先与页面交互，请点击这一行';
            }
        };
        audioContext.addEventListener('statechange', showState);
        panel.statusBar.parentNode.addEventListener('click', () => audioContext.resume());
        showState();
    }

    function setStatus(panel, message) {
        let text = new Date().toTimeString().slice(0, 8) + ' ' + message;
        panel.statusBar.innerText = text;
        console.log('[enaeaHelperPlus] ' + text);
    }

    function openLesson(panel, lessonUrl) {
        let lessonFrame = document.createElement('iframe');
        lessonFrame.src = lessonUrl;
        lessonFrame.allow = 'autoplay; fullscreen';
        lessonFrame.style.cssText = 'width:100%;height:100%;border:0;';
        panel.frameContainer.appendChild(lessonFrame);
        return lessonFrame;
    }

    // 学习页在计时启动失败时会调用 history.back()，在 iframe 中它会让目录页后退离开；
    // 先压入一个同地址的历史记录，后退只会触发目录页的 popstate，据此停止运行
    function watchHistoryBack(report) {
        history.pushState(null, '', window.location.href);
        return new Promise((resolve, reject) => {
            window.addEventListener('popstate', () => {
                report('学习页请求返回上一页，课程计时没有启动');
                reject(new Error('学习页请求返回上一页，课程计时没有启动'));
            }, { once: true });
        });
    }

    // 学时记录连续失败或检测到同时观看多门课程时，平台会停止计时并弹出这个对话框
    function findPlatformStopDialog(lessonDocument) {
        return lessonDocument.getElementById('showMessage_boxid');
    }

    function createVideoCourseHandler() {
        return {
            name: '视频',
            matches: (course) => course.coursecontentType === 'video',
            lessonUrl: (course, circleId) => '/viewerforccvideo.do?courseId=' + course.courseId + '&circleId=' + circleId,
            study: studyVideoCourse
        };
    }

    // 持续播放当前章节，章节进度达到 100% 后切换到下一个未完成章节，全部章节完成即学完这门课
    function studyVideoCourse(lessonFrame, report) {
        return new Promise((resolve, reject) => {
            let studyTimer = setInterval(() => {
                let lessonWindow = lessonFrame.contentWindow;
                let lessonDocument = lessonFrame.contentDocument;
                let stopDialog = findPlatformStopDialog(lessonDocument);
                if (stopDialog !== null) {
                    clearInterval(studyTimer);
                    report('平台停止计时：' + stopDialog.innerText);
                    reject(new Error('平台停止计时：' + stopDialog.innerText));
                    return;
                }
                continuePlayVideo(lessonWindow, lessonDocument);
                let currentChapter = lessonDocument.querySelector('.current.cvtb-MCK-course-content');
                if (currentChapter === null) {
                    return;
                }
                let currentChapterProgress = currentChapter.querySelector('.cvtb-MCK-CsCt-studyProgress');
                if (currentChapterProgress === null) {
                    return;
                }
                let currentChapterTitle = currentChapter.querySelector('.cvtb-MCK-CsCt-title').innerText;
                report('章节 ' + currentChapterTitle + ' 进度 ' + currentChapterProgress.innerText);
                if (currentChapterProgress.innerText !== '100%') {
                    return;
                }
                let incompleteChapterIndex = findIncompleteChapter(lessonDocument);
                if (incompleteChapterIndex >= 0) {
                    startChapter(lessonWindow, lessonDocument, incompleteChapterIndex);
                } else {
                    clearInterval(studyTimer);
                    resolve();
                }
            }, checkInterval);
        });
    }

    function findIncompleteChapter(lessonDocument) {
        let progressValueList = lessonDocument.querySelectorAll(".cvtb-MCK-CsCt-studyProgress");
        for (let i = 0; i < progressValueList.length; i++) {
            if (progressValueList[i].innerText !== '100%') {
                return i;
            }
        }
        return -1;
    }

    function startChapter(lessonWindow, lessonDocument, index) {
        let courseInfoList = lessonDocument.querySelectorAll(".cvtb-MCK-CsCt-info.clearfix");
        courseInfoList[index].click();
        let chapterTitle = lessonDocument.querySelectorAll(".cvtb-MCK-CsCt-title.cvtb-text-ellipsis")[index].innerText;
        continuePlayVideo(lessonWindow, lessonDocument);
        sleep(300).then(() => {
            console.log('Start learn: ' + chapterTitle);
            let continueButton = lessonDocument.getElementById("ccH5jumpInto");
            if (continueButton !== null) {
                continueButton.click();
            }
        });
    }

    // 学时按页面实际停留时间计算，视频播放超过三分之一后回到开头，保证视频一直处于播放状态
    function continuePlayVideo(lessonWindow, lessonDocument) {
        let video = lessonDocument.querySelector('video');
        if (video !== null) {
            video.muted = true;
            video.playbackRate = playbackSpeed;
            if (video.paused) {
                video.play();
            }
            if (video.currentTime > video.duration / 3) {
                video.currentTime = 0;
            }
        }
        closePausePopup(lessonWindow, lessonDocument);
    }

    function closePausePopup(lessonWindow, lessonDocument) {
        if (lessonDocument.getElementsByClassName("td-content").length !== 0) {
            console.log('Pause button found');
            let $ = lessonWindow.jQuery;
            $("button:contains('Continue Learning')").click();
            $(".dialog-content input").click(); // Answer options
            $(".dialog-button-container button").click(); // Answer dialog
        }
    }

    function createICourseHandler() {
        return {
            name: 'VR',
            matches: (course) => course.coursecontentType === 'external_link' && course.courseExternalType === 'icourse',
            lessonUrl: (course, circleId) => '/viewerforicourse.do?courseId=' + course.courseId + '&circleId=' + circleId,
            study: studyICourse
        };
    }

    // icourse(VR) 课程页自带计时模块，每分钟向 studyLog.do 提交一次学习时长；这里只读取这些响应中的 progress 判断是否学完。
    // 单次提交失败时平台会在下一分钟重试，只有平台弹出停止计时对话框时才终止
    function studyICourse(lessonFrame, report) {
        removeVrContent(lessonFrame);
        return new Promise((resolve, reject) => {
            let stopTimer = setInterval(() => {
                let stopDialog = findPlatformStopDialog(lessonFrame.contentDocument);
                if (stopDialog !== null) {
                    clearInterval(stopTimer);
                    report('平台停止计时：' + stopDialog.innerText);
                    reject(new Error('平台停止计时：' + stopDialog.innerText));
                }
            }, checkInterval);
            lessonFrame.addEventListener('load', () => {
                let lessonWindow = lessonFrame.contentWindow;
                lessonFrame.addEventListener('load', () => {
                    clearInterval(stopTimer);
                    report('VR 学习页发生了跳转');
                    reject(new Error('VR 学习页发生了跳转：' + lessonFrame.contentWindow.location.href));
                }, { once: true });
                report('等待页面计时');
                lessonWindow.jQuery(lessonWindow.document).ajaxComplete((event, xhr, settings) => {
                    if (settings.url.indexOf('studyLog.do') === -1) {
                        return;
                    }
                    if (xhr.status !== 200) {
                        report('学时记录请求失败，HTTP ' + xhr.status + '，等待页面下次计时');
                        return;
                    }
                    let result = JSON.parse(xhr.responseText);
                    if (!result.success) {
                        report('学时记录未成功：' + result.message + '，等待页面下次计时');
                        return;
                    }
                    report('进度 ' + result.progress + '%');
                    if (Number(result.progress) >= 100) {
                        clearInterval(stopTimer);
                        resolve();
                    }
                });
            }, { once: true });
        });
    }

    // VR 全景内容来自第三方网站(酷雷曼、720云等)，会自动播放背景音乐和解说；课程计时由学习公社页面自带的模块完成，与全景内容无关。
    // 学习页中一出现全景内容的 iframe 就把它移除，学习页加载完成后停止检查
    function removeVrContent(lessonFrame) {
        let removeTimer = setInterval(() => {
            let lessonDocument = lessonFrame.contentDocument;
            for (const contentFrame of lessonDocument.querySelectorAll('iframe')) {
                contentFrame.remove();
            }
            if (lessonFrame.contentWindow.location.pathname === '/viewerforicourse.do' && lessonDocument.readyState === 'complete') {
                clearInterval(removeTimer);
            }
        }, 50);
    }

    function getCourseListAction(type) {
        if (type === 'course') {
            return 'getMyClass';
        }
        return 'getMyClassFor' + type.substring('course'.length);
    }

    function isContentsPage() {
        return currentPagePath === '/circleIndexRedirect.do' && testURL('action', 'toNewMyClass') && (testURL('type', 'course')|| testURL('type', 'courseCategory4jwu'));
    }

    function getURLParameter(name) {
        let queryParams = window.location.search.substring(1);
        let variableList = queryParams.split("&");

        for (const element of variableList) {
            let parameterPair = element.split("=");

            if (parameterPair[0] === name) {
                return parameterPair[1];
            }
        }

        return '';
    }

    function testURL(name, value) {
        return getURLParameter(name) === value;
    }

    function sleep(time) {
        return new Promise((resolve) => setTimeout(resolve, time));
    }
})();
