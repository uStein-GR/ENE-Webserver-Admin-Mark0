const express = require('express');
const mysql = require('mysql');
const path = require('path');
const bodyParser = require('body-parser');
const app = express();
const port = 4000;
const multer = require('multer');
const xlsx = require('xlsx');
const fs = require('fs');

// กำหนดค่า multer สำหรับการอัปโหลดไฟล์
const upload = multer({ dest: 'uploads/' }); // โฟลเดอร์สำหรับเก็บไฟล์ที่อัปโหลด

// เพิ่มการตั้งค่า body-parser สำหรับ JSON และ URL-encoded
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

app.set('view engine', 'ejs');
app.use(express.static(path.join(__dirname, 'public')));

// สร้างการเชื่อมต่อฐานข้อมูล
const db = mysql.createConnection({
    host: 'localhost',
    user: 'root',
    password: 'g654321',
    database: 'db_mark_iii'
});

db.connect((err) => {
    if (err) throw err;
    console.log('Connected to MySQL Database');
});

app.get('/', (req, res) => {
    res.render('home');
});

// ฟังก์ชันเพื่อจัดรูปแบบวันที่ โดยตัดส่วนของโซนเวลาออก
const formatUpdateDate = (date) => {
    if (!date) return 'N/A';

    const bangkokTime = new Date(new Date(date).getTime() + 7 * 60 * 60 * 1000); // GMT+7
    return bangkokTime.toString().split('GMT')[0].trim();
};

// แสดงหน้า Upload พร้อม Dashboard ของ Subjects
app.get('/upload-subjects', (req, res) => {
    const { year, professor } = req.query;
    const getYearsSql = `SELECT DISTINCT year FROM subject ORDER BY year DESC`;
    const getProfessorsSql = `SELECT prof_id, name, surname FROM user`;

    let getSubjectsSql = `
        SELECT s.subj_id, s.course_name, s.subj_name, s.year, u.prof_id, s.update_data 
        FROM subject s
        JOIN user u ON s.prof_id = u.prof_id
        WHERE 1=1
    `;
    const params = [];

    db.query(getYearsSql, (err, years) => {
        if (err) return res.status(500).send("Error fetching years");

        const defaultYear = year || (years.length > 0 ? years[0].year : '');

        // ดึงข้อมูล professors จากฐานข้อมูล
        db.query(getProfessorsSql, (err, professors) => {
            if (err) return res.status(500).send("Error fetching professors");

            // รวมชื่อและนามสกุลของอาจารย์
            professors = professors.map(prof => {
                prof.full_name = `${prof.name} ${prof.surname}`; // รวมชื่อและนามสกุล
                return prof;
            });

            // เพิ่มเงื่อนไขของปีและอาจารย์
            if (defaultYear) {
                getSubjectsSql += ` AND s.year = ?`;
                params.push(defaultYear);
            }
            if (professor) {
                getSubjectsSql += ` AND CONCAT(u.name, ' ', u.surname) = ?`;
                params.push(professor);
            }

            db.query(getSubjectsSql, params, (err, subjects) => {
                if (err) return res.status(500).send("Error fetching subjects");

                subjects.forEach(subject => {
                    // รวมชื่อและนามสกุลของอาจารย์ใน column professor
                    const prof = professors.find(p => p.prof_id === subject.prof_id);
                    subject.professor = prof ? prof.full_name : 'Unknown';  // ถ้าไม่พบจะให้แสดง "Unknown"
                    subject.update_data = formatUpdateDate(subject.update_data); // ✅ Format date to Bangkok time
                });

                res.render('upload-subjects', { 
                    subjects, 
                    years, 
                    professors, 
                    selectedYear: defaultYear, 
                    selectedProfessor: professor || "" 
                });
            });
        });
    });
});


app.post('/update-subject', (req, res) => {
    const { subj_id, course_name, subj_name, year, professor } = req.body;
    
    console.log("Received Data:", req.body); // ตรวจสอบข้อมูลที่ได้รับ

    // ตรวจสอบว่ามี professor ในฐานข้อมูลหรือไม่
    const checkProfSql = `SELECT prof_id FROM user WHERE CONCAT(name, ' ', surname) = ?`;  // ใช้ full_name ในการตรวจสอบ
    db.query(checkProfSql, [professor], (err, results) => {
        if (err) {
            console.error(err);
            return res.json({ success: false });
        }

        // ถ้าไม่มี professor ที่ตรงกัน
        if (results.length === 0) {
            console.log("No matching professor found.");
            return res.json({ success: false });
        }

        const prof_id = results[0].prof_id;

        // คำสั่ง SQL สำหรับอัปเดตข้อมูล
        const updateSql = `
            UPDATE subject 
            SET course_name = ?, subj_name = ?, year = ?, prof_id = ?
            WHERE subj_id = ?
        `;
        
        db.query(updateSql, [course_name, subj_name, year, prof_id, subj_id], (err, result) => {
            if (err) {
                console.error(err);
                return res.json({ success: false });
            }
            console.log(result); // ตรวจสอบผลลัพธ์การอัปเดต
            res.json({ success: true });
        });
    });
});


app.get('/get-years', (req, res) => {
    const getYearsSql = `SELECT DISTINCT year FROM subject ORDER BY year ASC`;
    
    db.query(getYearsSql, (err, years) => {
        if (err) {
            console.error("Error fetching years:", err);
            return res.status(500).send("Error fetching years");
        }
        res.json(years); // ส่งข้อมูลปีออกมาเป็น JSON
    });
});

// ฟังก์ชันเพื่อดึงข้อมูลจากไฟล์ Excel และบันทึกลงฐานข้อมูล
app.post('/upload-excel', upload.single('excelFile'), (req, res) => {
    const filePath = req.file.path;
    
    // อ่านไฟล์ Excel
    const workbook = xlsx.readFile(filePath);
    const sheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];
    const data = xlsx.utils.sheet_to_json(sheet);

    // เตรียมข้อมูลสำหรับ insert ลงฐานข้อมูล โดยไม่เพิ่มคอลัมน์ update_data
    const subjects = data.map(row => [
        row.course_name,
        row.subj_name,
        row.year,
        row.prof_id
    ]);
    

    // สร้าง query สำหรับ insert ข้อมูล
    const sql = `
        INSERT INTO subject (course_name, subj_name, year, prof_id)
        VALUES ?
    `;


    // บันทึกข้อมูลลงฐานข้อมูล
    db.query(sql, [subjects], (err) => {
        // ลบไฟล์ที่อัปโหลดออกหลังการใช้งาน
        fs.unlinkSync(filePath);

        if (err) {
            console.error(err);
            return res.status(500).send('Error inserting data into the database');
        }

        res.send('Data uploaded successfully!');
    });
});

const excelJS = require('exceljs'); // ติดตั้งด้วย: npm install exceljs

app.post('/export-subjects', (req, res) => {
    const { year, professor } = req.body;

    let sql = `
        SELECT s.course_name, s.subj_name, s.year, CONCAT(u.name, ' ', u.surname) AS professor, s.update_data
        FROM subject s
        JOIN user u ON s.prof_id = u.prof_id
        WHERE 1=1
    `;
    const params = [];

    if (year) {
        sql += ' AND s.year = ?';
        params.push(year);
    }
    if (professor) {
        sql += ' AND CONCAT(u.name, " ", u.surname) = ?';
        params.push(professor);
    }

    db.query(sql, params, async (err, results) => {
        if (err) {
            console.error("Export Error:", err);
            return res.status(500).send("Failed to export data");
        }

        // สร้างไฟล์ Excel
        const workbook = new excelJS.Workbook();
        const worksheet = workbook.addWorksheet('Subjects');

        worksheet.columns = [
            { header: 'Course Name', key: 'course_name', width: 25 },
            { header: 'Subject Name', key: 'subj_name', width: 30 },
            { header: 'Year', key: 'year', width: 10 },
            { header: 'Professor', key: 'professor', width: 30 },
            { header: 'Update Date', key: 'update_data', width: 25 },
        ];

        results.forEach(row => {
            // ตรวจสอบ update_data ถ้าเป็น null หรือ 'N/A' ให้แปลงเป็น 'ยังไม่ได้อัปโหลด'
            let updateDateText = row.update_data;
            if (!updateDateText || updateDateText === 'N/A') {
                updateDateText = 'ยังไม่ได้อัปโหลด';
            }
        
            worksheet.addRow({
                course_name: row.course_name,
                subj_name: row.subj_name,
                year: row.year,
                professor: row.professor,
                update_data: updateDateText
            });
        });
        
        // ตั้งชื่อไฟล์ และตั้ง Header
        res.setHeader(
            'Content-Type',
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
        );
        res.setHeader(
            'Content-Disposition',
            'attachment; filename=subjects_export.xlsx'
        );

        await workbook.xlsx.write(res);
        res.end();
    });
});


// เริ่มต้นเซิร์ฟเวอร์
app.listen(port, () => {
    console.log(`Server running on port ${port}`);
});

app.post('/delete-subject', (req, res) => {
    const { subj_id } = req.body;

    const deleteSql = `DELETE FROM subject WHERE subj_id = ?`;
    db.query(deleteSql, [subj_id], (err, result) => {
        if (err) {
            console.error(err);
            return res.json({ success: false });
        }
        res.json({ success: true });
    });
});

app.get('/filter-subjects', (req, res) => {
    const { year, professor } = req.query;

    let filterSql = `
        SELECT s.subj_id, s.course_name, s.subj_name, s.year, u.name AS professor, s.update_data 
        FROM subject s
        JOIN user u ON s.prof_id = u.prof_id
        WHERE 1 = 1
    `;

    const params = [];

    // เพิ่มเงื่อนไขสำหรับ Year
    if (year) {
        filterSql += ' AND s.year = ?';
        params.push(year);
    }

    // เพิ่มเงื่อนไขสำหรับ Professor
    if (professor) {
        filterSql += ' AND u.name = ?';
        params.push(professor);
    }

    db.query(filterSql, params, (err, subjects) => {
        if (err) throw err;

        // ตัดโซนเวลาจากวันที่
        subjects.forEach(subject => {
            subject.update_data = formatUpdateDate(subject.update_data);
        });

        // ดึงข้อมูล Professor สำหรับ Dropdown
        const getProfessorsSql = `SELECT DISTINCT name FROM user`;
        db.query(getProfessorsSql, (err, professors) => {
            if (err) throw err;

            res.render('upload-subjects', { subjects, professors });
        });
    });
});


//หน้า Survey
app.get('/survey', (req, res) => {
    const { year } = req.query;
    const getSubjectYearsSql = `SELECT DISTINCT year FROM subject ORDER BY year DESC`;
    const getSurveyYearsSql = `SELECT DISTINCT survey_year AS year FROM pi_survey ORDER BY survey_year DESC`;
    const getResponsibleYearsSql = `SELECT DISTINCT resp_year AS year FROM responsible_committee ORDER BY resp_year DESC`;

    let getSurveySql = `
        SELECT ps.survey_id, p.PI_no, ps.PIS_score1, ps.PIS_score2, ps.PIS_score3, 
               ps.PIS_score4, ps.PIS_score5, ps.survey_year
        FROM pi_survey ps
        JOIN pi p ON ps.PI_id = p.PI_id
        WHERE 1=1
    `;

    const params = [];
    if (year) {
        getSurveySql += ` AND ps.survey_year = ?`;
        params.push(year);
    }

    db.query(getSubjectYearsSql, (err, subjectYears) => {
        if (err) return res.status(500).send("Error fetching subject years");

        db.query(getSurveyYearsSql, (err, surveyYears) => {
            if (err) return res.status(500).send("Error fetching survey years");

            db.query(getResponsibleYearsSql, (err, responsibleYears) => {
                if (err) return res.status(500).send("Error fetching responsible committee years");

                db.query(getSurveySql, params, (err, surveyData) => {
                    if (err) return res.status(500).send("Error fetching survey data");

                    const defaultYear = year || (surveyYears.length > 0 ? surveyYears[0].year : '');

                    // ถ้าไม่มีการเลือกปีใน query ให้ redirect ไปยังปีล่าสุด
                    if (!year && defaultYear) {
                        return res.redirect(`/survey?year=${defaultYear}`);
                    }
                    
                    res.render('survey', { 
                        subjectYears, 
                        surveyYears, 
                        responsibleYears, // ✅ ส่งค่าปีจาก responsible_committee ไปยัง front-end
                        surveyData, 
                        selectedYear: defaultYear
                    });
                });
            });
        });
    });
});

//
app.post('/survey/save', upload.single('survey_file'), (req, res) => {
    const { survey_year, weight } = req.body; // รับข้อมูลจากฟอร์ม
    const filePath = req.file.path;

    if (!survey_year || !filePath || weight === undefined) {
        return res.status(400).send("Year, file and weight are required");
    }

    // อ่านไฟล์ Excel
    const workbook = xlsx.readFile(filePath);
    const sheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];
    const data = xlsx.utils.sheet_to_json(sheet);

    // เตรียมข้อมูลสำหรับการ Insert ใน pi_survey
    const insertPromises = data.map(row => {
        return new Promise((resolve, reject) => {
            // ค้นหา PI_id จาก PI_no
            const findPISql = `SELECT PI_id FROM pi WHERE PI_no = ?`;
            db.query(findPISql, [row.PI_no], (err, results) => {
                if (err || results.length === 0) {
                    return reject(err || `PI not found for PI_no: ${row.PI_no}`);
                }

                const PI_id = results[0].PI_id;

                // บันทึกข้อมูลลง pi_survey
                const insertSurveySql = `
                    INSERT INTO pi_survey (PI_id, PIS_score1, PIS_score2, PIS_score3, PIS_score4, PIS_score5, survey_year) 
                    VALUES (?, ?, ?, ?, ?, ?, ?)`; 
                db.query(insertSurveySql, [PI_id, row.PIS_score1, row.PIS_score2, row.PIS_score3, row.PIS_score4, row.PIS_score5, survey_year], (err, result) => {
                    if (err) return reject(err);
                    resolve(result);
                });
            });
        });
    });

    // หลังจาก insert ข้อมูล survey แล้ว เราจะอัปเดตตาราง responsible_committee
    Promise.all(insertPromises)
        .then(() => {
            // คำสั่ง SQL สำหรับอัปเดตข้อมูลในตาราง responsible_committee
            const updateWeightSql = `
                UPDATE responsible_committee
                SET weight = ?
                WHERE resp_year = ?
            `;
            db.query(updateWeightSql, [weight, survey_year], (err, result) => {
                if (err) {
                    console.error("Error updating weight:", err);
                    return res.status(500).send("Error saving weight");
                }

                console.log("Survey data and weight saved successfully");
                res.redirect('/survey');
            });
        })
        .catch(err => {
            console.error("Error saving survey data:", err);
            res.status(500).send("Error saving survey data");
        });
});


//ตารางหน้า survey

app.post('/survey/update', (req, res) => {
    const { survey_id, PI_id, PIS_score1, PIS_score2, PIS_score3, PIS_score4, PIS_score5, survey_year } = req.body;

    const updateSql = `
        UPDATE pi_survey
        SET PI_id = ?, PIS_score1 = ?, PIS_score2 = ?, PIS_score3 = ?, PIS_score4 = ?, PIS_score5 = ?, survey_year = ?
        WHERE survey_id = ?
    `;

    db.query(updateSql, [PI_id, PIS_score1, PIS_score2, PIS_score3, PIS_score4, PIS_score5, survey_year, survey_id], (err, result) => {
        if (err) {
            console.error("Error updating survey data:", err);
            return res.json({ success: false });
        }
        res.json({ success: true });
    });
});

//
app.post('/survey/delete', (req, res) => {
    const { survey_id } = req.body;

    const deleteSql = `DELETE FROM pi_survey WHERE survey_id = ?`;

    db.query(deleteSql, [survey_id], (err, result) => {
        if (err) {
            console.error("Error deleting survey data:", err);
            return res.json({ success: false });
        }
        res.json({ success: true });
    });
});

//หน้า SO
app.get('/so', (req, res) => {
    const { year, professor } = req.query; // รับค่าปีและศาสตราจารย์ที่เลือก

    const getSubjectYearsSql = `SELECT DISTINCT year FROM subject ORDER BY year DESC`; // ดึงปีจากตาราง subject
    const getResponsibleYearsSql = `SELECT DISTINCT resp_year AS year FROM responsible_committee ORDER BY resp_year DESC`; // ดึงปีจาก responsible_committee
    const getCommitteesSql = `SELECT prof_id AS id, name, surname FROM user`; // ดึงชื่อและนามสกุลจากตาราง user
    const getPiSql = `SELECT PI_no FROM pi`;

    let getResponsibleCommitteeSql = `SELECT * FROM responsible_committee WHERE 1=1`;
    const params = [];

    db.query(getSubjectYearsSql, (err, subjectYears) => {
        if (err) return res.status(500).send("Error fetching subject years");

        db.query(getResponsibleYearsSql, (err, responsibleYears) => {
            if (err) return res.status(500).send("Error fetching responsible committee years");

            const defaultYear = year || (responsibleYears.length > 0 ? responsibleYears[0].year : ''); // ใช้ค่าปีล่าสุดเป็นค่าเริ่มต้น

            db.query(getCommitteesSql, (err, committees) => {
                if (err) return res.status(500).send("Error fetching committees");

                if (defaultYear) {
                    getResponsibleCommitteeSql += ` AND resp_year = ?`;
                    params.push(defaultYear);
                }
                if (professor) {
                    getResponsibleCommitteeSql += ` AND prof_id = ?`;
                    params.push(professor);
                }

                db.query(getPiSql, (err, piList) => {
                    if (err) return res.status(500).send("Error fetching PI_no");

                    // หาค่าที่มากที่สุดของ SO จาก PI_no
                    let maxSO = 1;
                    piList.forEach(pi => {
                        const match = pi.PI_no.match(/^PI(\d+)\.(\d+)$/);
                        if (match) {
                            const thirdDigit = parseInt(match[1]);
                            if (thirdDigit > maxSO) {
                                maxSO = thirdDigit;
                            }
                        }
                    });

                    db.query(getResponsibleCommitteeSql, params, (err, responsibleCommittees) => {
                        if (err) return res.status(500).send("Error fetching responsible committee");

                        // ดึง PI_no สำหรับทุก PI_id และแปลงเป็น SO
                        const getPI_no = `SELECT PI_no FROM pi WHERE PI_id = ?`;

                        responsibleCommittees.forEach(rc => {
                            db.query(getPI_no, [rc.PI_id], (err, piResult) => {
                                if (err) return console.error("Error fetching PI_no:", err);
                        
                                // กำหนดให้ PI_no เป็นตัวเลขหลักที่ 3 และแปลงเป็น SO1, SO2 เป็นต้น
                                const pi_no = piResult.length > 0 ? piResult[0].PI_no : '';
                                const thirdDigit = pi_no.match(/^PI(\d+)\.(\d+)$/);
                                if (thirdDigit) {
                                    rc.SO = `SO${thirdDigit[1]}`; // สร้าง SO เช่น SO1, SO2
                                } else {
                                    rc.SO = 'Unknown'; // ถ้าไม่พบ PI_no
                                }
                        
                                // เพิ่มข้อมูลชื่อและนามสกุลของศาสตราจารย์จาก committees
                                const prof = committees.find(committee => committee.id === rc.prof_id);
                                rc.prof_name = prof ? prof.name : ''; // เพิ่มชื่อของศาสตราจารย์
                                rc.prof_surname = prof ? prof.surname : ''; // เพิ่มนามสกุลของศาสตราจารย์
                        
                                // เมื่อตรวจสอบ PI_no เสร็จแล้ว ส่งข้อมูลไปที่หน้าเว็บ
                                if (responsibleCommittees.indexOf(rc) === responsibleCommittees.length - 1) {
                                    // แสดงข้อมูลในหน้าเว็บ
                                    res.render('so', { 
                                        subjectYears, 
                                        responsibleYears, 
                                        committees, 
                                        maxSO, 
                                        responsibleCommittees, 
                                        selectedYear: defaultYear, 
                                        selectedProfessor: professor || "" 
                                    });
                                }
                            });
                        });

                        // ถ้าไม่มีการวนลูป เช่นข้อมูลเป็นจำนวนที่น้อย ควรส่งข้อมูลไปก่อน
                        if (responsibleCommittees.length === 0) {
                            res.render('so', { 
                                subjectYears, 
                                responsibleYears, 
                                committees, 
                                maxSO, 
                                responsibleCommittees, 
                                selectedYear: defaultYear, 
                                selectedProfessor: professor || "" 
                            });
                        }
                    });
                });
            });
        });
    });
});


app.post("/save-committee", (req, res) => {
    const { committees } = req.body;

    if (!committees || committees.length === 0) {
        return res.json({ success: false, message: "No committee data received." });
    }

    // ดึงข้อมูล PI_no และ PI_id จากฐานข้อมูล
    const getPISql = `SELECT PI_id, PI_no FROM pi`;
    db.query(getPISql, (err, piList) => {
        if (err) {
            console.error("Error fetching PI data:", err);
            return res.json({ success: false, message: "Database fetch failed." });
        }

        // จัดกลุ่ม PI_id ตาม thirdDigit
        const piMap = {};
        piList.forEach(row => {
            const match = row.PI_no.match(/^PI(\d+)\.(\d+)$/);
            if (match) {
                const thirdDigit = parseInt(match[1]); // ตัวเลขหลักที่ 3
                if (!piMap[thirdDigit]) {
                    piMap[thirdDigit] = [];
                }
                piMap[thirdDigit].push(row.PI_id);
            }
        });

        console.log("PI Map:", piMap); // Debugging

        // หา PI_id ที่มีค่าต่ำสุดในแต่ละกลุ่ม
        const minPiMap = {};
        Object.keys(piMap).forEach(key => {
            minPiMap[key] = Math.min(...piMap[key]);
        });

        console.log("Minimum PI Map:", minPiMap); // Debugging

        // เตรียมข้อมูลสำหรับ Insert
        let insertValues = [];
        committees.forEach(c => {
            if (minPiMap[c.so_number]) {
                insertValues.push([minPiMap[c.so_number], c.prof_id, c.year]);
            }
        });

        if (insertValues.length === 0) {
            return res.json({ success: false, message: "No matching PI data found." });
        }

        // คำสั่ง SQL สำหรับ Insert ข้อมูล
        const insertQuery = `
            INSERT INTO responsible_committee (PI_id, prof_id, resp_year)
            VALUES ?
        `;

        db.query(insertQuery, [insertValues], (err, result) => {
            if (err) {
                console.error("Error inserting committee data:", err);
                return res.json({ success: false, message: "Database insert failed." });
            }
            res.json({ success: true });
        });
    });
});

app.post('/update-responsible-committee', (req, res) => {
    const { committee_id, professor_id, resp_year } = req.body;

    console.log("Received data:", { committee_id, professor_id, resp_year }); // ตรวจสอบข้อมูลที่ได้รับ

    // คำสั่ง SQL สำหรับอัปเดตข้อมูล
    const updateSql = `
        UPDATE responsible_committee
        SET prof_id = ?, resp_year = ?
        WHERE committee_id = ?
    `;
    
    db.query(updateSql, [professor_id, resp_year, committee_id], (err, result) => {
        if (err) {
            console.error("Error updating data:", err); // แสดงข้อผิดพลาดในกรณีที่มี error
            return res.status(500).json({ success: false, message: "Failed to update data" }); // ส่งข้อความ error กลับไป
        }
        console.log("Data updated successfully:", result);
        res.json({ success: true }); // ส่งผลลัพธ์สำเร็จกลับไป
    });
});


app.post('/delete-responsible-committee', (req, res) => {
    const { committee_id } = req.body;

    const deleteSql = `DELETE FROM responsible_committee WHERE committee_id = ?`;

    db.query(deleteSql, [committee_id], (err, result) => {
        if (err) {
            console.error("Error deleting committee data:", err);
            return res.json({ success: false });
        }
        res.json({ success: true });
    });
});

app.get('/get-responsible-years', (req, res) => {
    const getYearsSql = `SELECT DISTINCT resp_year AS year FROM responsible_committee ORDER BY resp_year DESC`;

    db.query(getYearsSql, (err, years) => {
        if (err) {
            console.error("Error fetching responsible committee years:", err);
            return res.status(500).send("Error fetching responsible committee years");
        }
        res.json(years);
    });
});

app.post('/survey/save-weight', (req, res) => {
    const { year, weight } = req.body;

    if (!year || weight === undefined) {
        return res.json({ success: false, message: 'Missing year or weight' });
    }

    const updateSql = `
        UPDATE responsible_committee
        SET weight = ?
        WHERE resp_year = ?
    `;

    db.query(updateSql, [weight, year], (err, result) => {
        if (err) {
            console.error("Error updating weight:", err);
            return res.json({ success: false });
        }
        res.json({ success: true });
    });
});
