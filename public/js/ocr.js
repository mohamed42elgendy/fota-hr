window.FOTAT_OCR = {
  async compressImage(file, maxWidth = 1100) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = (e) => {
        const img = new Image();
        img.onload = () => {
          const scale = Math.min(1, maxWidth / img.width);
          const canvas = document.createElement('canvas');
          canvas.width = Math.round(img.width * scale);
          canvas.height = Math.round(img.height * scale);
          const ctx = canvas.getContext('2d');
          ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
          resolve(canvas.toDataURL('image/jpeg', 0.85));
        };
        img.onerror = reject;
        img.src = e.target.result;
      };
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  },

  parseMrz(text) {
    const lines = text
      .split(/\r?\n/)
      .map((l) => l.replace(/\s+/g, '').toUpperCase())
      .filter((l) => l.length >= 25 && l.includes('<'));

    const res = { employeeName: '', docNumber: '', expiryDate: '' };
    const line1 = lines.find((l) => /^P<[A-Z]{3}/.test(l));
    if (line1) {
      const rawName = line1.slice(5).replace(/<+$/, '');
      const [surname, given] = rawName.split('<<');
      const parts = [given, surname]
        .filter(Boolean)
        .map((p) => p.replace(/</g, ' ').trim())
        .filter(Boolean);
      if (parts.length) {
        res.employeeName = parts
          .join(' ')
          .toLowerCase()
          .replace(/\b\w/g, (c) => c.toUpperCase());
      }
      const idx = lines.indexOf(line1);
      const line2 = lines[idx + 1];
      if (line2 && line2.length >= 27) {
        res.docNumber = line2.slice(0, 9).replace(/</g, '');
        const expRaw = line2.slice(21, 27);
        if (/^\d{6}$/.test(expRaw)) {
          res.expiryDate = `20${expRaw.slice(0, 2)}-${expRaw.slice(2, 4)}-${expRaw.slice(4, 6)}`;
        }
      }
    }
    return res;
  },

  extractNameFromText(text) {
    const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

    // 1. Arabic label match: الاسم: ...
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(/(?:الاسم|اسم\s+الموظف|الإسم)\s*[:\-]?\s*(.+)/);
      if (m && m[1] && m[1].trim().length >= 4) {
        return m[1].trim();
      }
      if (/^(?:الاسم|الإسم|Name|Full Name|Given Names?)$/i.test(lines[i]) && lines[i + 1]) {
        return lines[i + 1].trim();
      }
    }

    // 2. English label match: Name: ...
    for (const line of lines) {
      const m = line.match(/(?:Full\s*Name|Name|Holder)\s*[:\-]\s*([A-Za-z\s]{4,})/i);
      if (m && m[1]) return m[1].trim();
    }

    // 3. Multi-word Arabic name line (3-4 words, excluding common headers)
    const skipWords = /(جمهورية|مصر|جواز|سفر|إقامة|شهادة|صحية|بطاقة|تاريخ|الانتهاء|وزارة|الصحة|الداخلية)/;
    for (const line of lines) {
      if (!skipWords.test(line) && /^[\u0600-\u06FF\s]{8,45}$/.test(line) && line.split(/\s+/).length >= 2) {
        return line;
      }
    }

    return '';
  },

  normalizeDigits(str) {
    const arNums = '٠١٢٣٤٥٦٧٨٩';
    return str.replace(/[٠-٩]/g, (d) => String(arNums.indexOf(d)));
  },

  extractDates(rawText) {
    const text = this.normalizeDigits(rawText);
    const found = [];
    const pad = (n) => String(n).padStart(2, '0');
    const months = {
      JAN: '01', FEB: '02', MAR: '03', APR: '04', MAY: '05', JUN: '06',
      JUL: '07', AUG: '08', SEP: '09', OCT: '10', NOV: '11', DEC: '12'
    };

    // 1. YYYY-MM-DD or YYYY/MM/DD or YYYY.MM.DD
    const isoRe = /\b(20\d{2})\s*[-/.]\s*(\d{1,2})\s*[-/.]\s*(\d{1,2})\b/g;
    let m;
    while ((m = isoRe.exec(text)) !== null) {
      const mo = Number(m[2]);
      const dy = Number(m[3]);
      if (mo >= 1 && mo <= 12 && dy >= 1 && dy <= 31) {
        found.push(`${m[1]}-${pad(mo)}-${pad(dy)}`);
      }
    }

    // 2. DD/MM/YYYY or DD-MM-YYYY or DD.MM.YYYY
    const dmyRe = /\b(\d{1,2})\s*[-/.]\s*(\d{1,2})\s*[-/.]\s*(20\d{2})\b/g;
    while ((m = dmyRe.exec(text)) !== null) {
      const dy = Number(m[1]);
      const mo = Number(m[2]);
      if (mo >= 1 && mo <= 12 && dy >= 1 && dy <= 31) {
        found.push(`${m[3]}-${pad(mo)}-${pad(dy)}`);
      }
    }

    // 3. DD MMM YYYY or DD MMM / MMM YYYY (common in passports)
    const mmmRe = /\b(\d{1,2})\s*[-/ ]+\s*(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)[A-Z]*(?:\s*\/\s*[A-Z]+)?\s*[-/ ]+\s*(20\d{2}|\d{2})\b/gi;
    while ((m = mmmRe.exec(text)) !== null) {
      const dy = Number(m[1]);
      const mo = months[m[2].toUpperCase().slice(0, 3)];
      const yr = m[3].length === 2 ? `20${m[3]}` : m[3];
      if (mo && dy >= 1 && dy <= 31) {
        found.push(`${yr}-${mo}-${pad(dy)}`);
      }
    }

    // 4. DD/MM/YY
    const shortRe = /\b(\d{1,2})\s*[-/.]\s*(\d{1,2})\s*[-/.]\s*(2[4-9]|3\d)\b/g;
    while ((m = shortRe.exec(text)) !== null) {
      const dy = Number(m[1]);
      const mo = Number(m[2]);
      if (mo >= 1 && mo <= 12 && dy >= 1 && dy <= 31) {
        found.push(`20${m[3]}-${pad(mo)}-${pad(dy)}`);
      }
    }

    return found.sort();
  },

  parseDocumentText(text) {
    const result = { employeeName: '', docNumber: '', expiryDate: '' };
    if (!text) return result;
    const normText = this.normalizeDigits(text);

    // Try Passport MRZ first (most accurate)
    const mrz = this.parseMrz(normText);
    if (mrz.employeeName) result.employeeName = mrz.employeeName;
    if (mrz.docNumber) result.docNumber = mrz.docNumber;
    if (mrz.expiryDate) result.expiryDate = mrz.expiryDate;

    if (!result.employeeName) {
      result.employeeName = this.extractNameFromText(normText);
    }

    if (!result.docNumber) {
      const passportMatch = normText.match(/\b([A-Z]{1,2}\d{6,9})\b/i) || normText.match(/\b(\d{9,14})\b/);
      if (passportMatch) result.docNumber = passportMatch[1].toUpperCase();
    }

    if (!result.expiryDate) {
      const dates = this.extractDates(normText);
      if (dates.length > 0) {
        result.expiryDate = dates[dates.length - 1];
      }
    }

    return result;
  },

  async scanDocument(file, docType = '') {
    const imageDataUrl = await this.compressImage(file);
    let extracted = { employeeName: '', docNumber: '', expiryDate: '', jobTitle: '', rawText: '', source: '' };

    // 1. Try server-side Gemini Vision AI first
    let apiError = '';
    try {
      const apiRes = await fetch('/api/ocr', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ imageDataUrl, docType })
      });
      const data = await apiRes.json().catch(() => ({}));
      if (apiRes.ok) {
        let exp = data.expiryDate || '';
        if (exp && !/^\d{4}-\d{2}-\d{2}$/.test(exp)) {
          const d = this.extractDates(exp);
          if (d.length) exp = d[d.length - 1];
        }
        return {
          imageDataUrl,
          employeeName: data.employeeName || '',
          docNumber: data.docNumber || '',
          expiryDate: exp,
          jobTitle: data.jobTitle || '',
          source: 'gemini'
        };
      }
      apiError = data.error || `HTTP ${apiRes.status}`;
    } catch (e) {
      apiError = e.message || '';
    }

    // 2. Fallback to browser Tesseract.js
    if (window.Tesseract && typeof window.Tesseract.recognize === 'function') {
      try {
        const res = await window.Tesseract.recognize(imageDataUrl, 'eng+ara');
        const text = res?.data?.text || '';
        extracted = { ...extracted, ...this.parseDocumentText(text), rawText: text, source: 'tesseract' };
      } catch (err) {
        console.warn('OCR fallback:', err);
      }
    }

    return { imageDataUrl, ...extracted, apiError };
  }
};
