const http = require('http');

function postJSON(url, data) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const bodyStr = JSON.stringify(data);
    const options = {
      hostname: u.hostname,
      port: u.port,
      path: u.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(bodyStr)
      }
    };

    const req = http.request(options, (res) => {
      let responseBody = '';
      res.on('data', (chunk) => responseBody += chunk);
      res.on('end', () => {
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body: responseBody
        });
      });
    });

    req.on('error', reject);
    req.write(bodyStr);
    req.end();
  });
}

function getJSON(url, token) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const options = {
      hostname: u.hostname,
      port: u.port,
      path: u.pathname + (u.search || ''),
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${token}`
      }
    };

    const req = http.request(options, (res) => {
      let responseBody = '';
      res.on('data', (chunk) => responseBody += chunk);
      res.on('end', () => {
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body: responseBody
        });
      });
    });

    req.on('error', reject);
    req.end();
  });
}

async function run() {
  try {
    console.log('1. Logging in as Budi Santoso...');
    const loginRes = await postJSON('http://localhost:5000/api/auth/teacher/login', {
      schoolCode: 'SMA1',
      email: 'teacher.teladan@gmail.com',
      password: 'password123'
    });

    console.log('Login Status:', loginRes.statusCode);
    console.log('Login Body:', loginRes.body);

    const loginData = JSON.parse(loginRes.body);
    if (!loginData.token) {
      console.error('Failed to get token!');
      return;
    }

    const token = loginData.token;

    console.log('\n2. Fetching courses list...');
    const coursesRes = await getJSON('http://localhost:5000/api/courses', token);
    console.log('Courses Status:', coursesRes.statusCode);
    console.log('Courses Body:', coursesRes.body);

    const courses = JSON.parse(coursesRes.body);
    if (courses.length === 0) {
      console.log('No courses found!');
      return;
    }

    const firstCourseId = courses[0].id;
    console.log(`\n3. Fetching gradebook for course ID ${firstCourseId}...`);
    const gradebookRes = await getJSON(`http://localhost:5000/api/gradebook/${firstCourseId}`, token);
    console.log('Gradebook Status:', gradebookRes.statusCode);
    console.log('Gradebook Body:', gradebookRes.body);

  } catch (err) {
    console.error('HTTP Test failed:', err);
  }
}

run();
