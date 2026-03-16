const BUILD_SHA = require('./_build-sha');
const SHORT_SHA = BUILD_SHA === 'dev' ? 'dev' : BUILD_SHA.slice(0, 7);
const GITHUB_URL = `https://github.com/johnturek/prompt-platform/commit/${BUILD_SHA}`;

module.exports = function footer() {
    const label = BUILD_SHA === 'dev' ? 'dev' : SHORT_SHA;
    const content = BUILD_SHA === 'dev'
        ? `<span style="color:#94a3b8">dev build</span>`
        : `<a href="${GITHUB_URL}" target="_blank" rel="noopener" style="color:#94a3b8;text-decoration:none;transition:color 0.15s" onmouseover="this.style.color='#64748b'" onmouseout="this.style.color='#94a3b8'">build&nbsp;${label}</a>`;
    return `<footer style="text-align:center;padding:1.5rem 1rem 1rem;font-size:0.72rem;letter-spacing:0.03em">${content}</footer>`;
};
