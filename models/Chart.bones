model = Backbone.Model.extend();

model.prototype.deepGet = function(key) {
    var deepGet = function(attr, keys) {
        var key = keys.shift();
        if (keys.length) {
            return deepGet(attr[key] || {}, keys);
        } else {
            return attr[key];
        }
    }
    return deepGet(this.attributes, key.split('.'));
};

model.prototype.deepSet = function(key, val, options) {
    var deepSet = function(attr, keys, val) {
        var key = keys.shift();
        if (keys.length) {
            if (keys.length === 1 && !isNaN(parseInt(keys[0]))) {
                attr[key] = attr[key] || [];
            } else {
                attr[key] = attr[key] || {};
            }
            attr[key] = deepSet(attr[key], keys, val);
        } else {
            attr[key] = val;
        }
        return attr;
    }
    var root = key.split('.').shift();
    var attr = {};
    attr[root] = this.attributes[root];
    return this.set(deepSet(attr, key.split('.'), val), options)
        .trigger('change')
        .trigger('change:' + root);
};

model.prototype.compileZoom = function(rules, key, val) {
    var prefix = key.split('-').shift();
    var filters = this.get('_'+prefix+'-filters') || {};
    var scale = this.get('_'+prefix+'-scale') || 1;
    var zoom = filters.zoom || [0,22];
    val = _(val).isArray() ? val[0] : val;

    if (scale <= 1) {
        rules[key] = val;
    } else {
        for (var z = zoom[0], i = 0; z <= zoom[1]; z++, i++) {
            rules['[zoom='+z+']'] = rules['[zoom='+z+']'] || {};
            rules['[zoom='+z+']'][key] = val + '*' + Math.pow(scale,i).toFixed(2);
        }
    }
    return this;
};

model.prototype.compileMarker = function(rules, key, val) {
    var prefix = key.split('-').shift();
    var filters = this.get('_'+prefix+'-filters') || {};
    var field = this.get('_'+prefix+'-field');
    var range = this.get('_'+prefix+'-range');

    if (!field || !range || val.length < 2) {
        rules[key] = val;
    } else {
        var breaks = 5; // @TODO configurable.
        var diffRange = (range[1] - range[0]) / (breaks - 1);
        var diffValue = (val[1] - val[0]) / (breaks - 1);
        for (var i = 0; i < breaks; i++) {
            var group = _('[<%=f%>>=<%=min%>]').template({
                f:field,
                min: range[0] + diffRange*i
            });
            rules[group] = rules[group] || {};
            this.compileZoom(rules[group], key, val[0] + diffValue*i);
        }
    }
    return this;
};

model.prototype.compileShades = function(rules, key, val) {
    var prefix = key.split('-').shift();
    var field = this.get('_'+prefix+'-field');
    var range = this.get('_'+prefix+'-range');

    if (!field || !range || val.length < 2) {
        rules[key] = val;
    } else {
        var breaks = val.length;
        var diffRange = (range[1] - range[0]) / (breaks - 1);
        for (var i = 0; i < breaks; i++) {
            var group = _('[<%=f%>>=<%=min%>]').template({
                f: field,
                min: range[0] + diffRange*i
            });
            rules[group] = rules[group] || {};
            rules[group][key] = val[i];
        }
    }
    return this;
};

model.prototype.compile = function(layer) {
    var tree = _(this.toJSON()).reduce(_(function(memo, val, key) {
        if (key === 'id') return memo;
        if (key.indexOf('_') === 0) return memo;
        var prefix = key.split('-').shift();
        var filters = this.get('_'+prefix+'-filters') || {};
        var group = '::' + prefix + _(filters).map(function(val, key) {
            return _('[<%=k%>>=<%=v[0]%>][<%=k%><=<%=v[1]%>]')
                .template({ k:key, v:val });
        }).join('');
        switch (prefix) {
        case 'background':
            memo[key] = val;
            break;
        case 'polygon':
            memo[group] = memo[group] || {};
            memo[group][key] = val;
            switch (key) {
            case 'polygon-fill':
                this.compileShades(memo[group], key, val);
                break;
            default:
                memo[group][key] = val;
                break;
            }
            break;
        case 'line':
            if (!this.get('line-width')) return memo;
            memo[group] = memo[group] || {};
            switch (key) {
            case 'line-width':
                this.compileZoom(memo[group], key, val);
                break;
            default:
                memo[group][key] = val;
                break;
            }
            break;
        case 'text':
            if (!this.get('text-name')) return memo;
            if (!this.get('text-size')) return memo;
            memo[group] = memo[group] || {};
            memo[group]['text-allow-overlap'] = 'true';
            switch (key) {
            case 'text-size':
            case 'text-character-spacing':
                this.compileZoom(memo[group], key, val);
                break;
            default:
                memo[group][key] = val;
                break;
            }
            break;
        case 'marker':
            if (!this.get('marker-width')) return memo;
            memo[group] = memo[group] || {};
            memo[group]['marker-allow-overlap'] = 'true';
            switch(key) {
            case 'marker-width':
            case 'marker-line-width':
                this.compileMarker(memo[group], key, val);
                break;
            default:
                memo[group][key] = val;
                break;
            }
            break;
        }
        return memo;
    }).bind(this), {});
    tree = _(tree).chain().keys()
        .sortBy(function(key) {
            if (key.indexOf('::fill') === 0) return 0;
            if (key.indexOf('::line') === 0) return 1;
            if (key.indexOf('::text') === 0) return 2;
            return 0;
        })
        .reduce(function(memo, key) {
            memo[key] = tree[key];
            return memo;
        }, {})
        .value();
    var rules = {};
    if (this.id === 'Map') {
        rules[this.id] = tree;
    } else {
        rules['#'+this.id] = tree;
    }
//    console.warn(this.toCSS(rules));
    return this.toCSS(rules);
};

model.prototype.toCSS = function(rules, indent) {
    indent = indent || '';
    return _(rules).map(_(function(val, key) {
        val = _(val).isArray() ? val[0] : val;

        // Recurse for objects.
        if (_(val).isObject()) return _(val).size() > 1
            ? [ indent + key + ' {', this.toCSS(val, indent + '  '), indent + '}' ].join('\n')
            : [ indent + key + ' {', this.toCSS(val), '}' ].join(' ');

        // Quoted attributes. @TODO use the Carto reference JSON for this.
        switch (key) {
        case 'text-name':
            return indent + key + ': "[' + val + ']";';
            break;
        case 'text-face-name':
            return indent + key + ': "' + val + '";';
            break;
        default:
            return indent + key + ': ' + val + ';';
            break;
        }
    }).bind(this)).join('\n');
};
