package com.qwen.mobileshell

import android.Manifest
import android.annotation.SuppressLint
import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.ContentValues
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.Rect
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.MediaStore
import android.util.Base64
import android.webkit.MimeTypeMap
import android.widget.Toast
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder
import javax.net.ssl.HttpsURLConnection
import android.text.InputType
import android.text.method.PasswordTransformationMethod
import android.view.View
import android.view.ViewGroup
import android.webkit.JsPromptResult
import android.webkit.JsResult
import android.webkit.PermissionRequest
import android.webkit.RenderProcessGoneDetail
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.CheckBox
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.lifecycle.Lifecycle
import androidx.webkit.ProfileStore
import androidx.webkit.WebStorageCompat
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature

class MainActivity : AppCompatActivity() {
    private var store: AndroidProfileStore? = null
    private var state = ProfileState()
    private var webView: WebView? = null
    private var activeProfile: ConnectionProfile? = null
    private var activeDialog: AlertDialog? = null
    private var activeJsResult: JsResult? = null
    private var connectionAttempt = 0
    private var recovery: ConnectionRecovery? = null
    private val filePicker: NativeFilePicker by lazy { NativeFilePicker(this) { filePickerLauncher.launch(it) } }
    private val filePickerLauncher = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) {
        filePicker.result(it.resultCode, it.data)
    }
    private var microphoneDialog: AlertDialog? = null
    private var microphoneAuthorized = false
    private val microphone: NativeMicrophonePermission by lazy {
        NativeMicrophonePermission(
            { ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED },
            { microphoneLauncher.launch(Manifest.permission.RECORD_AUDIO) },
            { microphoneAuthorized = true },
        )
    }
    private val microphoneLauncher = registerForActivityResult(ActivityResultContracts.RequestPermission()) {
        microphone.result(it)
    }
    private var notificationPermissionAsked = false
    private val notificationLauncher = registerForActivityResult(ActivityResultContracts.RequestPermission()) { }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        filePicker.restoreAwaitingResult(savedInstanceState?.getBoolean("file-picker-in-flight") ?: false)
        microphone.restoreAwaitingResult(savedInstanceState?.getBoolean("microphone-in-flight") ?: false)
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                val view = webView
                val profile = activeProfile
                if (view != null && view.parent != null && profile != null &&
                    OriginPolicy.isSameOrigin(profile.origin, view.url.orEmpty())
                ) {
                    view.evaluateJavascript(
                        "(typeof window.__qwenHandleBack === 'function' ? Boolean(window.__qwenHandleBack()) : false)",
                    ) { raw ->
                        if (raw == "true" || isFinishing || isDestroyed) return@evaluateJavascript
                        if (view === webView && view.parent != null && view.canGoBack()) {
                            view.goBack()
                        } else if (activeProfile != null) {
                            showProfiles()
                        }
                    }
                } else if (view != null && view.parent != null && view.canGoBack()) {
                    view.goBack()
                } else if (activeProfile != null) {
                    showProfiles()
                } else {
                    isEnabled = false
                    onBackPressedDispatcher.onBackPressed()
                }
            }
        })
        loadProfiles(ConnectionRecovery.fromBundle(savedInstanceState?.getBundle("connection-recovery")))
        if (savedInstanceState == null) {
            handleDeepLinkIntent(intent)
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        handleDeepLinkIntent(intent)
    }

    override fun onStart() {
        super.onStart()
        ForegroundVisibility.isForeground = true
        webView?.onResume()
        webView?.resumeTimers()
        val view = webView
        val profile = activeProfile
        if (view != null && view.parent != null && profile != null &&
            OriginPolicy.isSameOrigin(profile.origin, view.url.orEmpty())
        ) {
            view.evaluateJavascript(
                "if (typeof window.__qwenNativeWake === 'function') { window.__qwenNativeWake(); }",
                null,
            )
        }
    }

    private fun loadProfiles(snapshot: ConnectionRecovery? = null) {
        try {
            val storage = store ?: AndroidProfileStore(this).also { store = it }
            state = storage.vault.load()
            retireBrowserProfiles()
            if (snapshot != null) {
                restoreConnection(snapshot)
            } else {
                val singlePaired = state.profiles.singleOrNull()?.takeIf { !it.token.isNullOrBlank() }
                if (singlePaired != null) {
                    connect(singlePaired, ConnectionNavigation(ui = true))
                } else {
                    showProfiles()
                }
            }
        } catch (_: Exception) { showStorageError() }
    }

    private fun restoreConnection(snapshot: ConnectionRecovery) {
        val profile = snapshot.findProfile(state) ?: return showProfiles()
        if (snapshot.retryRequired) showRecovery(snapshot)
        else connect(profile, snapshot.navigation)
    }

    private fun showRecovery(snapshot: ConnectionRecovery) {
        recovery = snapshot.copy(retryRequired = true)
        showMessage(getString(R.string.connection_interrupted), getString(R.string.connection_resume_hint)) {
            restoreConnection(snapshot.copy(retryRequired = false))
        }
    }

    private fun retireBrowserProfiles() {
        if (WebViewCompat.getCurrentWebViewPackage(this) == null) return
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.MULTI_PROFILE)) return
        val profiles = ProfileStore.getInstance()
        val live = state.profiles.map { it.browserName }.toSet()
        val retired = profiles.allProfileNames.filter { it.startsWith("qwen-") && it !in live }
        val pending = state.retiredBrowsers.toMutableSet()
        for (name in retired + pending.toList()) {
            try {
                profiles.deleteProfile(name)
                pending.remove(name)
            } catch (_: IllegalStateException) { pending.add(name) }
        }
        if (pending != state.retiredBrowsers) {
            val next = state.copy(retiredBrowsers = pending)
            store!!.vault.save(next)
            state = next
        }
    }

    private fun column(): LinearLayout = LinearLayout(this).apply {
        orientation = LinearLayout.VERTICAL
        val padding = (20 * resources.displayMetrics.density).toInt()
        setPadding(padding, padding, padding, padding)
    }

    private fun LinearLayout.label(value: String, heading: Boolean = false): TextView =
        TextView(context).apply { text = value; textSize = if (heading) 22f else 16f }
            .also { addView(it) }

    private fun LinearLayout.button(value: String, action: () -> Unit): Button =
        Button(context).apply { text = value; setOnClickListener { action() } }
            .also { addView(it) }

    private fun showProfiles() {
        destroyConnection()
        val content = column().apply {
            label(getString(R.string.connections), true)
            label(getString(R.string.development_notice))
            if (state.profiles.isEmpty()) label(getString(R.string.no_profiles))
            for (profile in state.profiles) {
                label(profile.name, true)
                label(profile.origin)
                button(getString(R.string.connect)) { connect(profile) }
                    .contentDescription = getString(R.string.connect_profile, profile.name)
                button(getString(R.string.connect_rc)) { connect(profile, ConnectionNavigation(ui = true)) }
                    .contentDescription = getString(R.string.connect_rc_profile, profile.name)
                button(getString(R.string.edit)) { editProfile(profile) }
                    .contentDescription = getString(R.string.edit_named_profile, profile.name)
                button(getString(R.string.delete)) {
                    activeDialog = AlertDialog.Builder(this@MainActivity)
                        .setTitle(R.string.delete_profile)
                        .setMessage(getString(R.string.delete_profile_message, profile.name))
                        .setNegativeButton(android.R.string.cancel, null)
                        .setPositiveButton(R.string.delete) { _, _ ->
                            try {
                                state = store!!.vault.remove(state, profile)
                                showProfiles()
                            } catch (_: Exception) { showStorageError() }
                        }.show()
                }.contentDescription = getString(R.string.delete_named_profile, profile.name)
            }
            button(getString(R.string.add_profile)) { editProfile(null) }
        }
        setContentView(ScrollView(this).apply { addView(content) })
    }

    private fun editProfile(previous: ConnectionProfile?) {
        val form = column().apply { importantForAutofill = View.IMPORTANT_FOR_AUTOFILL_NO_EXCLUDE_DESCENDANTS }
        fun field(label: Int, value: String, type: Int): EditText {
            val caption = form.label(getString(label))
            return EditText(this).apply {
                id = View.generateViewId()
                caption.labelFor = id
                hint = getString(label)
                setText(value)
                isSingleLine = true
                inputType = type
                if (label == R.string.daemon_token) transformationMethod = PasswordTransformationMethod.getInstance()
                isSaveEnabled = false
                form.addView(this)
            }
        }
        val name = field(R.string.profile_name, previous?.name.orEmpty(), InputType.TYPE_CLASS_TEXT)
        val address = field(R.string.daemon_address, previous?.origin.orEmpty(), InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_URI)
        val token = field(R.string.daemon_token, "", InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD)
        val keep = CheckBox(this).apply {
            text = getString(R.string.keep_credential)
            isChecked = previous?.token != null
            visibility = if (previous?.token != null) View.VISIBLE else View.GONE
            form.addView(this)
        }
        form.label(getString(R.string.credential_hint))
        val error = TextView(this).apply { accessibilityLiveRegion = View.ACCESSIBILITY_LIVE_REGION_POLITE }
            .also { form.addView(it) }
        fun showError(message: CharSequence?) {
            error.text = message
            error.post { error.requestRectangleOnScreen(Rect(0, 0, error.width, error.height), false) }
        }
        val dialog = AlertDialog.Builder(this)
            .setTitle(if (previous == null) R.string.add_profile else R.string.edit_profile)
            .setView(ScrollView(this).apply { addView(form) })
            .setNegativeButton(android.R.string.cancel, null)
            .setPositiveButton(R.string.save, null)
            .create()
        activeDialog = dialog
        dialog.setOnDismissListener { token.text.clear() }
        dialog.setOnShowListener {
            dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener {
                try {
                    val typed = token.text.toString()
                    val sameOrigin = OriginPolicy.canonicalRoot(address.text.toString().trim()) == previous?.origin
                    require(!(typed.isEmpty() && keep.isChecked && !sameOrigin)) { getString(R.string.changed_origin_credential) }
                    val credential = if (typed.isNotEmpty()) typed else if (keep.isChecked && sameOrigin) previous?.token else null
                    val profile = ConnectionProfile.create(name.text.toString(), address.text.toString(), credential, previous)
                    state = store!!.vault.upsert(state, profile)
                    dialog.dismiss()
                    showProfiles()
                } catch (invalid: IllegalArgumentException) { showError(invalid.message) }
                catch (_: Exception) { showError(getString(R.string.save_failed)) }
            }
        }
        dialog.show()
    }

    private fun connect(profile: ConnectionProfile, navigation: ConnectionNavigation = ConnectionNavigation()) {
        destroyConnection()
        try { state = store!!.vault.load() }
        catch (_: Exception) { showStorageError(); return }
        val current = state.profiles.find { it.id == profile.id && it.browserId == profile.browserId }
            ?: return showProfiles()
        recovery = ConnectionRecovery(current.id, current.browserId, navigation)
        val major = WebViewCompat.getCurrentWebViewPackage(this)?.versionName?.substringBefore('.')?.toIntOrNull()
        if (major == null || major < 111) {
            showMessage(getString(R.string.provider_update), getString(R.string.provider_requirement))
            return
        }
        if (WebViewFeature.isFeatureSupported(WebViewFeature.MULTI_PROFILE)) {
            try {
                val profiles = ProfileStore.getInstance()
                if (BrowserProfilePreparation.isPending(current.browserName)) {
                    activeProfile = current
                    showMessage(getString(R.string.preparing_browser), getString(R.string.preparing_browser_hint)) { connect(current, navigation) }
                    return
                }
                if (!current.needsBrowserInitialization(profiles.allProfileNames)) {
                    openConnection(current)
                    return
                }
                state = store!!.vault.setBrowserInitialized(state, current, false)
                if (WebViewFeature.isFeatureSupported(WebViewFeature.DELETE_BROWSING_DATA)) {
                    activeProfile = current
                    if (!BrowserProfilePreparation.reserve(current.browserName)) {
                        showMessage(getString(R.string.preparing_browser), getString(R.string.preparing_browser_hint)) { connect(current, navigation) }
                        return
                    }
                    val attempt = connectionAttempt
                    showMessage(getString(R.string.preparing_browser), getString(R.string.preparing_browser_hint))
                    try {
                        WebStorageCompat.deleteBrowsingData(profiles.getOrCreateProfile(current.browserName).webStorage) {
                            BrowserProfilePreparation.release(current.browserName)
                            if (attempt != connectionAttempt || isDestroyed || isFinishing) return@deleteBrowsingData
                            try {
                                state = store!!.vault.load()
                                if (state.profiles.none { it.id == current.id && it.browserId == current.browserId }) {
                                    showProfiles()
                                    return@deleteBrowsingData
                                }
                                state = store!!.vault.setBrowserInitialized(state, current, true)
                                openConnection(state.profiles.first { it.id == current.id && it.browserId == current.browserId })
                            } catch (_: Exception) { showStorageError() }
                        }
                    } catch (_: Exception) {
                        BrowserProfilePreparation.release(current.browserName)
                        showMessage(getString(R.string.browser_preparation_failed), getString(R.string.preparing_browser_hint)) { connect(current, navigation) }
                    }
                } else showMessage(getString(R.string.provider_update), getString(R.string.provider_requirement))
            } catch (_: Exception) { showStorageError() }
        } else showMessage(getString(R.string.provider_update), getString(R.string.provider_requirement))
    }

    @SuppressLint("SetJavaScriptEnabled", "RequiresFeature")
    private fun openConnection(profile: ConnectionProfile, pairCodeFragment: String? = null) {
        val view = WebView(this)
        if (WebViewFeature.isFeatureSupported(WebViewFeature.MULTI_PROFILE)) {
            WebViewCompat.setProfile(view, profile.browserName)
        } else {
            view.destroy()
            showMessage(getString(R.string.provider_update), getString(R.string.provider_requirement))
            return
        }
        val nav = recovery?.navigation ?: ConnectionNavigation()
        val bridgeSupported = nav.ui &&
            WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT) &&
            WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)
        if (bridgeSupported) {
            installQwenBridge(view, profile)
        }
        val fragment = when {
            pairCodeFragment != null -> "code=${Uri.encode(pairCodeFragment)}"
            bridgeSupported -> null // delivered via window.qwen.__pendingToken, never URL or localStorage
            profile.token != null -> "token=${Uri.encode(profile.token)}"
            else -> null
        }
        val loadUrl = Uri.parse(nav.url(profile.origin)).buildUpon()
            .encodedFragment(fragment).build().toString()
        webView = view
        activeProfile = profile
        view.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            allowContentAccess = false
            allowFileAccess = false
            setSupportZoom(true)
            builtInZoomControls = true
            displayZoomControls = false
        }
        view.webChromeClient = object : WebChromeClient() {
            override fun onShowFileChooser(view: WebView, callback: ValueCallback<Array<Uri>>, params: FileChooserParams): Boolean =
                filePicker.open(params, {
                    view === webView && view.parent != null && OriginPolicy.isSameOrigin(profile.origin, view.url.orEmpty())
                }, callback)
            override fun onPermissionRequest(request: PermissionRequest) {
                if (!microphone.begin(request, profile.origin) {
                    !isFinishing && !isDestroyed && lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED) &&
                        view === webView && view.parent != null && OriginPolicy.isSameOrigin(profile.origin, view.url.orEmpty())
                }) return
                cancelDialog()
                microphoneDialog = AlertDialog.Builder(this@MainActivity)
                    .setTitle(R.string.microphone_title)
                    .setMessage(getString(R.string.microphone_consent, profile.origin))
                    .setPositiveButton(R.string.microphone_allow) { _, _ ->
                        microphoneDialog = null
                        microphone.decide(request, true)
                    }
                    .setNegativeButton(android.R.string.cancel) { _, _ -> cancelMicrophone() }
                    .setOnCancelListener { cancelMicrophone() }.show()
            }

            override fun onPermissionRequestCanceled(request: PermissionRequest) {
                if (microphone.cancelledByWebView(request)) dismissMicrophoneDialog()
            }

            override fun onJsConfirm(view: WebView, url: String, message: String, result: JsResult): Boolean {
                if (view !== webView || !OriginPolicy.isSameOrigin(profile.origin, url)) {
                    result.cancel()
                    return true
                }
                cancelDialog()
                activeJsResult = result
                activeDialog = AlertDialog.Builder(this@MainActivity)
                    .setMessage(message)
                    .setPositiveButton(android.R.string.ok) { _, _ ->
                        if (view === webView) activeJsResult?.confirm() else activeJsResult?.cancel()
                        activeJsResult = null
                        activeDialog = null
                    }
                    .setNegativeButton(android.R.string.cancel) { _, _ -> cancelDialog() }
                    .setOnCancelListener { cancelDialog() }.show()
                return true
            }

            override fun onJsPrompt(
                view: WebView,
                url: String,
                message: String,
                defaultValue: String?,
                result: JsPromptResult,
            ): Boolean {
                if (view !== webView || !OriginPolicy.isSameOrigin(profile.origin, url)) {
                    result.cancel()
                    return true
                }
                cancelDialog()
                activeJsResult = result
                val pad = (16 * resources.displayMetrics.density).toInt()
                val input = EditText(this@MainActivity).apply {
                    inputType = InputType.TYPE_CLASS_TEXT
                    setText(defaultValue.orEmpty())
                    setSelection(text.length)
                }
                val box = LinearLayout(this@MainActivity).apply {
                    orientation = LinearLayout.VERTICAL
                    setPadding(pad, pad / 2, pad, 0)
                    addView(input)
                }
                activeDialog = AlertDialog.Builder(this@MainActivity)
                    .setMessage(message)
                    .setView(box)
                    .setPositiveButton(android.R.string.ok) { _, _ ->
                        val promptRes = activeJsResult as? JsPromptResult
                        if (view === webView) promptRes?.confirm(input.text?.toString().orEmpty())
                        else promptRes?.cancel()
                        activeJsResult = null
                        activeDialog = null
                    }
                    .setNegativeButton(android.R.string.cancel) { _, _ -> cancelDialog() }
                    .setOnCancelListener { cancelDialog() }.show()
                return true
            }
        }
        view.webViewClient = object : WebViewClient() {
            override fun doUpdateVisitedHistory(view: WebView, url: String, isReload: Boolean) {
                if (view === webView && OriginPolicy.isSameOrigin(profile.origin, url)) {
                    recovery = recovery?.copy(navigation = ConnectionNavigation.capture(profile.origin, url))
                }
            }

            override fun onPageStarted(view: WebView, url: String, favicon: Bitmap?) {
                if (view === webView) {
                    filePicker.cancel()
                    cancelMicrophone()
                }
            }

            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                if (view !== webView) return true
                if (OriginPolicy.isSameOrigin(profile.origin, request.url.toString())) return false
                if (request.isForMainFrame && OriginPolicy.isExternalLink(request.url.toString())) {
                    try { startActivity(Intent(Intent.ACTION_VIEW, request.url)) }
                    catch (_: ActivityNotFoundException) { }
                    catch (_: SecurityException) { }
                }
                return true
            }

            override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
                if (view === webView && request.isForMainFrame) showConnectionError(view, profile)
            }

            override fun onReceivedHttpError(view: WebView, request: WebResourceRequest, errorResponse: WebResourceResponse) {
                if (view === webView && request.isForMainFrame) showConnectionError(view, profile)
            }

            override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
                if (view === webView) {
                    val snapshot = recovery ?: ConnectionRecovery(profile.id, profile.browserId)
                    destroyConnection()
                    showRecovery(snapshot)
                }
                return true
            }
        }
        showWebView(view)
        view.loadUrl(loadUrl)
    }

    private fun showWebView(view: WebView) {
        (view.parent as? ViewGroup)?.removeView(view)
        setContentView(view)
    }

    private fun showConnectionError(view: WebView, profile: ConnectionProfile) {
        if (view !== webView) return
        val snapshot = recovery ?: ConnectionRecovery(profile.id, profile.browserId)
        destroyConnection()
        showRecovery(snapshot)
    }

    private fun showMessage(title: String, message: String, retry: (() -> Unit)? = null) {
        setContentView(ScrollView(this).apply {
            addView(column().apply {
                label(title, true)
                label(message)
                if (retry != null) button(getString(R.string.retry), retry)
                button(getString(R.string.connections)) { showProfiles() }
            })
        })
    }

    private fun showStorageError() {
        destroyConnection()
        val content = column().apply {
            label(getString(R.string.storage_unavailable), true)
            label(getString(R.string.storage_unavailable_hint))
                .accessibilityLiveRegion = View.ACCESSIBILITY_LIVE_REGION_POLITE
            button(getString(R.string.retry)) { loadProfiles() }
            button(getString(R.string.reset_profiles)) {
                activeDialog = AlertDialog.Builder(this@MainActivity)
                    .setTitle(R.string.reset_profiles)
                    .setMessage(R.string.reset_profiles_warning)
                    .setNegativeButton(android.R.string.cancel, null)
                    .setPositiveButton(R.string.reset_profiles) { _, _ ->
                        try {
                            val storage = store ?: AndroidProfileStore(this@MainActivity).also { store = it }
                            storage.reset()
                            loadProfiles()
                        } catch (_: Exception) { showStorageError() }
                    }.show()
            }
        }
        setContentView(ScrollView(this).apply { addView(content) })
    }

    private fun cancelDialog() {
        activeJsResult?.cancel()
        activeJsResult = null
        val dialog = activeDialog
        activeDialog = null
        dialog?.setOnCancelListener(null)
        dialog?.dismiss()
    }

    private fun destroyConnection() {
        connectionAttempt++
        BackgroundSseService.stop(this)
        filePicker.cancel()
        cancelMicrophone()
        microphoneAuthorized = false
        cancelDialog()
        val previous = webView
        webView = null
        activeProfile = null
        recovery = null
        (previous?.parent as? ViewGroup)?.removeView(previous)
        previous?.stopLoading()
        previous?.destroy()
    }

    override fun onDestroy() {
        destroyConnection()
        super.onDestroy()
    }

    private fun dismissMicrophoneDialog() {
        val dialog = microphoneDialog
        microphoneDialog = null
        dialog?.setOnCancelListener(null)
        dialog?.dismiss()
    }

    private fun cancelMicrophone() {
        microphone.cancel()
        dismissMicrophoneDialog()
    }

    @Suppress("DEPRECATION")
    override fun startActivityForResult(intent: Intent, requestCode: Int, options: Bundle?) {
        val view = webView
        val profile = activeProfile
        if (microphoneAuthorized && view != null && profile != null &&
            intent.action in listOf(Intent.ACTION_OPEN_DOCUMENT, Intent.ACTION_CREATE_DOCUMENT)) {
            // Finish the launcher's request after it has returned, without opening a doomed picker.
            window.decorView.post {
                onActivityResult(requestCode, Activity.RESULT_CANCELED, null)
                if (view !== webView || profile !== activeProfile || isFinishing || isDestroyed) return@post
                cancelMicrophone()
                cancelDialog()
                activeDialog = AlertDialog.Builder(this)
                    .setTitle(R.string.microphone_files_title)
                    .setMessage(R.string.microphone_files_reconnect)
                    .setNegativeButton(R.string.keep_editing, null)
                    .setPositiveButton(R.string.reconnect) { _, _ ->
                        if (view === webView && profile === activeProfile) connect(profile)
                    }.show()
            }
            return
        }
        super.startActivityForResult(intent, requestCode, options)
    }

    override fun onStop() {
        ForegroundVisibility.isForeground = false
        cancelMicrophone()
        val profile = activeProfile
        if (microphoneAuthorized && profile != null) {
            destroyConnection()
            showMessage(getString(R.string.microphone_closed), getString(R.string.microphone_reconnect)) { connect(profile) }
        }
        super.onStop()
    }

    @SuppressLint("RequiresFeature")
    private fun installQwenBridge(view: WebView, profile: ConnectionProfile) {
        val rule = setOf(QwenBridgeInjector.originRule(profile.origin))
        val shellVersion = try {
            packageManager.getPackageInfo(packageName, 0).versionName ?: "0.23.3"
        } catch (_: Exception) {
            "0.23.3"
        }
        WebViewCompat.addWebMessageListener(view, QwenBridgeInjector.JS_OBJECT_NAME, rule) { _, message, sourceOrigin, isMainFrame, replyProxy ->
            if (!isMainFrame || !OriginPolicy.isSameOrigin(profile.origin, sourceOrigin.toString())) return@addWebMessageListener
            val req = QwenBridgeInjector.parseRequest(message.data) ?: return@addWebMessageListener
            when (req.method) {
                "getToken" -> {
                    val tok = try {
                        store?.vault?.load()?.profiles?.find { it.id == profile.id }?.token
                    } catch (_: Exception) {
                        null
                    }
                    replyProxy.postMessage(QwenBridgeInjector.formatSuccessReply(req.id, QwenBridgeInjector.jsStringLiteral(tok)))
                }
                "setToken" -> {
                    try {
                        val storage = store ?: AndroidProfileStore(this).also { store = it }
                        val latest = storage.vault.load()
                        val current = latest.profiles.find { it.id == profile.id }
                        if (current != null) {
                            val updated = current.copy(token = req.token?.takeIf { it.isNotEmpty() })
                            state = storage.vault.upsert(latest, updated)
                            activeProfile = updated
                        }
                        replyProxy.postMessage(QwenBridgeInjector.formatSuccessReply(req.id, "null"))
                    } catch (_: Exception) {
                        replyProxy.postMessage(QwenBridgeInjector.formatErrorReply(req.id, "storage_error"))
                    }
                }
                "clearToken" -> {
                    try {
                        val storage = store ?: AndroidProfileStore(this).also { store = it }
                        val latest = storage.vault.load()
                        val current = latest.profiles.find { it.id == profile.id }
                        if (current != null) {
                            val updated = current.copy(token = null)
                            state = storage.vault.upsert(latest, updated)
                            activeProfile = updated
                        }
                        BackgroundSseService.stop(this)
                        replyProxy.postMessage(QwenBridgeInjector.formatSuccessReply(req.id, "null"))
                    } catch (_: Exception) {
                        replyProxy.postMessage(QwenBridgeInjector.formatErrorReply(req.id, "storage_error"))
                    }
                }
                "isBiometricAvailable", "requireBiometric" -> {
                    replyProxy.postMessage(QwenBridgeInjector.formatSuccessReply(req.id, "false"))
                }
                "openExternal" -> {
                    val target = req.url.orEmpty()
                    if (OriginPolicy.isExternalLink(target)) {
                        try { startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(target))) }
                        catch (_: Exception) { }
                    }
                    replyProxy.postMessage(QwenBridgeInjector.formatSuccessReply(req.id, "null"))
                }
                "setWatchedSession" -> {
                    if (req.watchedCleared || req.watched == null) {
                        BackgroundSseService.stop(this)
                    } else {
                        ensureNotificationPermission()
                        BackgroundSseService.startOrUpdate(this, profile.id, req.watched)
                    }
                    replyProxy.postMessage(QwenBridgeInjector.formatSuccessReply(req.id, "null"))
                }
                "consumeDispatchedOutbox" -> {
                    val drained = BackgroundSseService.consumeDispatchedOutbox(req.sessionId)
                    replyProxy.postMessage(
                        QwenBridgeInjector.formatSuccessReply(req.id, SimpleJson.formatStringArray(drained)),
                    )
                }
                "showConnections" -> {
                    replyProxy.postMessage(QwenBridgeInjector.formatSuccessReply(req.id, "null"))
                    runOnUiThread { showProfiles() }
                }
                "downloadWorkspaceFile" -> {
                    val filePath = req.filePath
                    if (filePath.isNullOrBlank()) {
                        replyProxy.postMessage(QwenBridgeInjector.formatErrorReply(req.id, "invalid_path"))
                        return@addWebMessageListener
                    }
                    val tok = try {
                        activeProfile?.token ?: store?.vault?.load()?.profiles?.find { it.id == profile.id }?.token
                    } catch (_: Exception) {
                        activeProfile?.token
                    }
                    if (tok.isNullOrBlank()) {
                        replyProxy.postMessage(QwenBridgeInjector.formatErrorReply(req.id, "missing_token"))
                        return@addWebMessageListener
                    }
                    val rawName = req.filename ?: filePath.substringAfterLast('/')
                    val safeName = rawName.replace(Regex("[\\\\/:*?\"<>|\\x00-\\x1f]+"), "_").trim().ifEmpty { "download" }
                    val ext = safeName.substringAfterLast('.', "").lowercase()
                    val mime = MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext) ?: "application/octet-stream"
                    val baseOrigin = profile.origin.trimEnd('/') + "/"
                    val ws = req.workspace
                    Thread({
                        try {
                            val values = ContentValues().apply {
                                put(MediaStore.Downloads.DISPLAY_NAME, safeName)
                                put(MediaStore.Downloads.MIME_TYPE, mime)
                                put(MediaStore.Downloads.IS_PENDING, 1)
                            }
                            val resolver = applicationContext.contentResolver
                            val uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values)
                                ?: throw IllegalStateException("downloads_insert_failed")
                            var totalWritten = 0L
                            var offset = 0L
                            val windowBytes = 256 * 1024
                            val maxTotal = 50L * 1024L * 1024L
                            try {
                                resolver.openOutputStream(uri)?.use { out ->
                                    while (offset < maxTotal) {
                                        val qPath = URLEncoder.encode(filePath, "UTF-8")
                                        val qWs = if (!ws.isNullOrBlank()) "&workspace=" + URLEncoder.encode(ws, "UTF-8") else ""
                                        val endpoint = "${baseOrigin}rc/workspace/file/bytes?path=$qPath&offset=$offset&maxBytes=$windowBytes$qWs"
                                        val conn = (URL(endpoint).openConnection() as HttpURLConnection).apply {
                                            requestMethod = "GET"
                                            connectTimeout = 10_000
                                            readTimeout = 20_000
                                            setRequestProperty("Authorization", "Bearer $tok")
                                            setRequestProperty("Accept", "application/json")
                                        }
                                        val body = try {
                                            if (conn.responseCode != 200) {
                                                throw IllegalStateException("http_${conn.responseCode}")
                                            }
                                            conn.inputStream.bufferedReader(Charsets.UTF_8).use { it.readText() }
                                        } finally {
                                            conn.disconnect()
                                        }
                                        val parsed = SimpleJson.parseFlatObject(body) ?: throw IllegalStateException("invalid_json")
                                        val b64 = (parsed["contentBase64"] as? String).orEmpty()
                                        val chunk = if (b64.isNotEmpty()) Base64.decode(b64, Base64.DEFAULT) else ByteArray(0)
                                        if (chunk.isNotEmpty()) {
                                            out.write(chunk)
                                            totalWritten += chunk.size
                                        }
                                        val returned = (parsed["returnedBytes"] as? String)?.toLongOrNull() ?: chunk.size.toLong()
                                        val totalSize = (parsed["sizeBytes"] as? String)?.toLongOrNull() ?: 0L
                                        val truncated = parsed["truncated"] == true
                                        offset += returned
                                        if (!truncated || returned <= 0L || (totalSize > 0L && offset >= totalSize)) {
                                            break
                                        }
                                    }
                                } ?: throw IllegalStateException("downloads_stream_failed")
                                val doneValues = ContentValues().apply {
                                    put(MediaStore.Downloads.IS_PENDING, 0)
                                }
                                resolver.update(uri, doneValues, null, null)
                            } catch (e: Exception) {
                                try { resolver.delete(uri, null, null) } catch (_: Exception) {}
                                throw e
                            }
                            val resultJson = """{"ok":true,"filename":${QwenBridgeInjector.jsStringLiteral(safeName)},"sizeBytes":$totalWritten}"""
                            runOnUiThread {
                                Toast.makeText(this@MainActivity, "Saved $safeName to Downloads", Toast.LENGTH_SHORT).show()
                                replyProxy.postMessage(QwenBridgeInjector.formatSuccessReply(req.id, resultJson))
                            }
                        } catch (_: Exception) {
                            runOnUiThread {
                                replyProxy.postMessage(QwenBridgeInjector.formatErrorReply(req.id, "download_failed"))
                            }
                        }
                    }, "qwen-rc-download").start()
                }
                "saveBase64File" -> {
                    val b64 = req.dataBase64
                    if (b64.isNullOrEmpty()) {
                        replyProxy.postMessage(QwenBridgeInjector.formatErrorReply(req.id, "invalid_data"))
                        return@addWebMessageListener
                    }
                    val rawName = req.filename ?: "download"
                    val safeName = rawName.replace(Regex("[\\\\/:*?\"<>|\\x00-\\x1f]+"), "_").trim().ifEmpty { "download" }
                    val ext = safeName.substringAfterLast('.', "").lowercase()
                    val mime = req.mimeType?.takeIf { it.isNotBlank() }
                        ?: MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext)
                        ?: "application/octet-stream"
                    Thread({
                        try {
                            val bytes = Base64.decode(b64, Base64.DEFAULT)
                            val values = ContentValues().apply {
                                put(MediaStore.Downloads.DISPLAY_NAME, safeName)
                                put(MediaStore.Downloads.MIME_TYPE, mime)
                                put(MediaStore.Downloads.IS_PENDING, 1)
                            }
                            val resolver = applicationContext.contentResolver
                            val uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values)
                                ?: throw IllegalStateException("downloads_insert_failed")
                            try {
                                resolver.openOutputStream(uri)?.use { out ->
                                    out.write(bytes)
                                } ?: throw IllegalStateException("downloads_stream_failed")
                                val doneValues = ContentValues().apply {
                                    put(MediaStore.Downloads.IS_PENDING, 0)
                                }
                                resolver.update(uri, doneValues, null, null)
                            } catch (e: Exception) {
                                try { resolver.delete(uri, null, null) } catch (_: Exception) {}
                                throw e
                            }
                            val resultJson = """{"ok":true,"filename":${QwenBridgeInjector.jsStringLiteral(safeName)},"sizeBytes":${bytes.size}}"""
                            runOnUiThread {
                                Toast.makeText(this@MainActivity, "Saved $safeName to Downloads", Toast.LENGTH_SHORT).show()
                                replyProxy.postMessage(QwenBridgeInjector.formatSuccessReply(req.id, resultJson))
                            }
                        } catch (_: Exception) {
                            runOnUiThread {
                                replyProxy.postMessage(QwenBridgeInjector.formatErrorReply(req.id, "save_failed"))
                            }
                        }
                    }, "qwen-rc-save-b64").start()
                }
                else -> {
                    replyProxy.postMessage(QwenBridgeInjector.formatErrorReply(req.id, "unsupported_method"))
                }
            }
        }
        WebViewCompat.addDocumentStartJavaScript(
            view,
            QwenBridgeInjector.buildDocumentStartScript(shellVersion, profile.token, profile.name),
            rule,
        )
    }

    private fun ensureNotificationPermission() {
        if (notificationPermissionAsked || Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            notificationPermissionAsked = true
            notificationLauncher.launch(Manifest.permission.POST_NOTIFICATIONS)
        }
    }

    private fun handleDeepLinkIntent(incoming: Intent?) {
        val data = incoming?.dataString ?: return
        if (!data.startsWith("qwen-rc:", ignoreCase = true)) return
        when (val parsed = QwenRcDeepLink.parseSchemeUri(data)) {
            is QwenRcDeepLink.Invalid -> {
                Toast.makeText(this, getString(R.string.deeplink_invalid, parsed.reason), Toast.LENGTH_LONG).show()
            }
            is QwenRcDeepLink.OpenSession -> {
                val targetProfile = activeProfile ?: state.profiles.firstOrNull() ?: return
                val view = webView
                if (view != null && view.parent != null && activeProfile?.id == targetProfile.id && OriginPolicy.isSameOrigin(targetProfile.origin, view.url.orEmpty())) {
                    val sidLit = QwenBridgeInjector.jsStringLiteral(parsed.sessionId)
                    val cwdLit = QwenBridgeInjector.jsStringLiteral(parsed.cwd)
                    view.evaluateJavascript(
                        "if (typeof window.__qwenOpenSession === 'function') { window.__qwenOpenSession($sidLit, null, $cwdLit); }",
                        null,
                    )
                    return
                }
                connect(targetProfile, parsed.toNavigation())
            }
            is QwenRcDeepLink.OpenPermission -> {
                val targetProfile = activeProfile ?: state.profiles.firstOrNull() ?: return
                val view = webView
                if (view != null && view.parent != null && activeProfile?.id == targetProfile.id && OriginPolicy.isSameOrigin(targetProfile.origin, view.url.orEmpty())) {
                    val permLit = QwenBridgeInjector.jsStringLiteral(parsed.permissionId)
                    view.evaluateJavascript(
                        "if (typeof window.__qwenOpenSession === 'function') { window.__qwenOpenSession(null, $permLit); }",
                        null,
                    )
                    return
                }
                connect(targetProfile, parsed.toNavigation())
            }
            is QwenRcDeepLink.PairDaemon -> {
                confirmAndPairDaemon(parsed)
            }
        }
    }

    private fun confirmAndPairDaemon(pair: QwenRcDeepLink.PairDaemon) {
        Thread({
            val fingerprint = try {
                val conn = (URL("${pair.daemonOrigin}rc/health").openConnection() as HttpsURLConnection).apply {
                    connectTimeout = 8_000
                    readTimeout = 8_000
                }
                try {
                    conn.connect()
                    val cert = conn.serverCertificates.firstOrNull()
                    if (cert != null) QwenRcDeepLink.formatCertSha256GroupedHex(cert.encoded) else "(unavailable)"
                } finally {
                    conn.disconnect()
                }
            } catch (_: Exception) {
                "(TLS probe failed - verify daemon reachability)"
            }
            runOnUiThread {
                if (isFinishing || isDestroyed) return@runOnUiThread
                cancelDialog()
                activeDialog = AlertDialog.Builder(this)
                    .setTitle(R.string.pair_confirm_title)
                    .setMessage(getString(R.string.pair_confirm_body, pair.daemonOrigin, fingerprint))
                    .setNegativeButton(android.R.string.cancel, null)
                    .setPositiveButton(R.string.pair_confirm_go) { _, _ ->
                        try {
                            val storage = store ?: AndroidProfileStore(this).also { store = it }
                            val latest = storage.vault.load()
                            val existing = latest.profiles.find { it.origin == pair.daemonOrigin }
                            val target = existing ?: ConnectionProfile.create(
                                Uri.parse(pair.daemonOrigin).host ?: "Remote Control",
                                pair.daemonOrigin,
                                null,
                            ).also { created ->
                                state = storage.vault.upsert(latest, created)
                            }
                            recovery = ConnectionRecovery(target.id, target.browserId, ConnectionNavigation(ui = true))
                            openConnection(target, pairCodeFragment = pair.code)
                        } catch (_: Exception) {
                            showStorageError()
                        }
                    }.show()
            }
        }, "qwen-rc-tls-probe").start()
    }

    override fun onSaveInstanceState(outState: Bundle) {
        val profile = activeProfile
        val view = webView
        if (microphoneAuthorized) {
            recovery = null
        } else if (profile != null && view != null && OriginPolicy.isSameOrigin(profile.origin, view.url.orEmpty())) {
            recovery = recovery?.copy(navigation = ConnectionNavigation.capture(profile.origin, view.url))
        }
        recovery?.let { outState.putBundle("connection-recovery", it.toBundle()) }
        outState.putBoolean("microphone-in-flight", microphone.awaitingResult)
        outState.putBoolean("file-picker-in-flight", filePicker.awaitingResult)
        super.onSaveInstanceState(outState)
    }
}
