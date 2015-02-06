Zotero.CookieSandbox.prototype._attachToInterfaceRequestor = Zotero.CookieSandbox.prototype.attachToInterfaceRequestor;
/**
 * Replaces Zotero.CookieSandbox.prototype.attachToInterfaceRequestor to allow the cookieSandbox
 * to time out XMLHttpRequests
 */
Zotero.CookieSandbox.prototype.attachToInterfaceRequestor = function(ir) {
	// Check that we are not timed out
	if(this.timedOut) {
		throw "Translation timed out; no further XMLHttpRequests allowed";
	}
	
	if(ir instanceof Components.interfaces.nsIXMLHttpRequest) {
		// Add to list of xhrs
		if(!this.xhrs) {
			this.xhrs = [ir];
		} else {
			this.xhrs.push(ir);
		}
		
		var xhrs = this.xhrs;
		ir.addEventListener("loadend", function() {
			var index = xhrs.indexOf(ir);
			if(index !== -1) xhrs.shift(index, 1);
		}, false);
	}
	
	this._attachToInterfaceRequestor(ir);
};

/**
 * Sets a timeout for XHRs connected to a CookieSandbox
 */
Zotero.CookieSandbox.prototype.setTimeout = function(timeout, callback) {
	this.timedOut = false;
	this.clearTimeout();
	this._timer = Components.classes["@mozilla.org/timer;1"].
		createInstance(Components.interfaces.nsITimer);
	this._timerCallback = {"notify":(function() {
		this.timedOut = true;
		callback();
		this.clearTimeout();
		if(this.xhrs) {
			for(var i=0; i<this.xhrs.length; i++) {
				this.xhrs[i].abort();
			}
		}
	}).bind(this)};
	this._timer.initWithCallback(this._timerCallback, timeout, Components.interfaces.nsITimer.TYPE_ONE_SHOT);
};

/**
 * Clears a timeout for XHRs connected to a CookieSandbox
 */
Zotero.CookieSandbox.prototype.clearTimeout = function() {
	if(this._timer) {
		this._timer.cancel();
		delete this._timer;
		delete this._timerCallback;
	}
};

/**
 * Load one or more documents in a hidden browser
 *
 * @param {String|String[]} urls URL(s) of documents to load
 * @param {Function} processor Callback to be executed for each document loaded
 * @param {Function} done Callback to be executed after all documents have been loaded
 * @param {Function} exception Callback to be executed if an exception occurs
 * @param {Boolean} dontDelete Unused.
 * @param {Zotero.CookieSandbox} [cookieSandbox] Cookie sandbox object
 * @return {browser} Hidden browser used for loading
 */
Zotero.HTTP.processDocuments = function(urls, processor, done, exception, dontDelete, cookieSandbox) {
	var xmlhttp = Components.classes["@mozilla.org/xmlextras/xmlhttprequest;1"].createInstance();
	xmlhttp.mozBackgroundRequest = true;
	
	if(typeof urls === "string") urls = [urls];
					
	/**
	 * Loads the next page
	 * @inner
	 */
	var url;
	var doLoad = function() {
		if(urls.length) {
			var urlString = urls.shift();
			try {
				url = Services.io.newURI(urlString, "UTF-8", null).
					QueryInterface(Components.interfaces.nsIURL);
			} catch(e) {
				if(exception) {
					exception("Invalid URL "+urlString);
					return;
				} else {
					throw(e);
				}
			}
			
			Zotero.debug("Loading "+url.spec);
			xmlhttp.open('GET', url.spec, true);
			// This doesn't return if we use responseType = document. Don't know why.
			xmlhttp.responseType = "document";
			
			// Send cookie even if "Allow third-party cookies" is disabled (>=Fx3.6 only)
			var channel = xmlhttp.channel;
			channel.QueryInterface(Components.interfaces.nsIHttpChannelInternal);
			channel.forceAllowThirdPartyCookie = true;
			channel.loadFlags |= Components.interfaces.nsIRequest.LOAD_BYPASS_CACHE;
			
			if(cookieSandbox) cookieSandbox.attachToInterfaceRequestor(xmlhttp);
			xmlhttp.send();
		} else {
			if(done) done();
		}
	};
	
	/**
	 * Callback to be executed when a page load completes
	 * @inner
	 */
	var onLoad = function() {
		var doc = xmlhttp.response;		
		if(doc || !exception) {
			try {
				doc = Zotero.HTTP.wrapDocument(doc, url);
				processor(doc);
			} catch(e) {
				if(exception) {
					exception(e);
					return;
				} else {
					throw(e);
				}
			}
		} else if(exception) {
			exception("XMLHttpRequest failed unexpectedly");
		}
		
		doLoad();
	};
	
	if(cookieSandbox) cookieSandbox.attachToInterfaceRequestor(xmlhttp);
	if(exception) {
		xmlhttp.onerror = xmlhttp.onabort = xmlhttp.ontimeout = function() {
			exception("XMLHttpRequest experienced an error");
			doLoad();
		};
		xmlhttp.onload = onLoad;
	} else {
		xmlhttp.onloadend = onLoad;
	}
	
	doLoad();
}


/**
 * Converts an item from toArray() format to content=json format used by the server
 */
Zotero.Utilities.itemToServerJSON = function(item) {
    var newItem = {};
    Zotero.debug = Zotero.Debug.log;

    var typeID = Zotero.ItemTypes.getID(item.itemType);
    if(!typeID) {
        Zotero.debug("itemToServerJSON: Invalid itemType "+item.itemType+"; using webpage");
        item.itemType = "webpage";
        typeID = Zotero.ItemTypes.getID(item.itemType);
    }

    var fieldID, itemFieldID;
    for(var field in item) {
        if(field === "complete" || field === "itemID" || field === "seeAlso")
            continue;

        var val = item[field];

        if(field === "itemType") {
            newItem[field] = val;
        } else if(field === "creators") {
            // normalize creators
            var n = val.length;
            var newCreators = newItem.creators = [];
            for(var j=0; j<n; j++) {
                var creator = val[j];

                if(!creator.firstName && !creator.lastName) {
                    Zotero.debug("itemToServerJSON: Silently dropping empty creator");
                    continue;
                }

                // Single-field mode
                if (!creator.firstName || (creator.fieldMode && creator.fieldMode == 1)) {
                    var newCreator = {
                        name: creator.lastName
                    };
                }
                // Two-field mode
                else {
                    var newCreator = {
                        firstName: creator.firstName,
                        lastName: creator.lastName
                    };
                }

                // ensure creatorType is present and valid
                if(creator.creatorType) {
                    if(Zotero.CreatorTypes.getID(creator.creatorType)) {
                        newCreator.creatorType = creator.creatorType;
                    } else {
                        Zotero.debug("itemToServerJSON: Invalid creator type "+creator.creatorType+"; falling back to author");
                    }
                }
                if(!newCreator.creatorType) newCreator.creatorType = "author";

                newCreators.push(newCreator);
            }
        } else if(field === "tags") {
            // normalize tags
            var n = val.length;
            var newTags = newItem.tags = [];
            for(var j=0; j<n; j++) {
                var tag = val[j];
                if(typeof tag === "object") {
                    if(tag.tag) {
                        tag = tag.tag;
                    } else if(tag.name) {
                        tag = tag.name;
                    } else {
                        Zotero.debug("itemToServerJSON: Discarded invalid tag");
                        continue;
                    }
                } else if(tag === "") {
                    continue;
                }
                newTags.push({"tag":tag.toString(), "type":1});
            }
        } else if(field === "notes") {
            // normalize notes
            var n = val.length;
            var newNotes = newItem.notes = new Array(n);
            for(var j=0; j<n; j++) {
                var note = val[j];
                if(typeof note === "object") {
                    if(!note.note) {
                        Zotero.debug("itemToServerJSON: Discarded invalid note");
                        continue;
                    }
                    note = note.note;
                }
                newNotes[j] = {"itemType":"note", "note":note.toString()};
            }
        } else if((fieldID = Zotero.ItemFields.getID(field))) {
            // if content is not a string, either stringify it or delete it
            if(typeof val !== "string") {
                if(val || val === 0) {
                    val = val.toString();
                } else {
                    continue;
                }
            }

            // map from base field if possible
            if((itemFieldID = Zotero.ItemFields.getFieldIDFromTypeAndBase(typeID, fieldID))) {
                var fieldName = Zotero.ItemFields.getName(itemFieldID);
                // Only map if item field does not exist
                if(fieldName !== field && !newItem[fieldName]) newItem[fieldName] = val;
                continue;	// already know this is valid
            }

            // if field is valid for this type, set field
            if(Zotero.ItemFields.isValidForType(fieldID, typeID)) {
                newItem[field] = val;
            } else {
                Zotero.debug("itemToServerJSON: Discarded field "+field+": field not valid for type "+item.itemType, 3);
            }
        } else if (field === "attachments") {
            newItem[field] = val;
        } else {
            Zotero.debug("itemToServerJSON: Discarded unknown field "+field, 3);
        }
    }

    return newItem;
};
